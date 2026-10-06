import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type EventId, eventPath, parseEventPath, type Sha } from "../core/ids.js";
import { finalizeEvent, type Intent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import type { LogOutcome, State } from "../core/reducer/state.js";
import { EventIdSchema, MAX_EVENT_BYTES } from "../core/schemas/common.js";
import { serializeEvent } from "../core/schemas/events.js";
import { type Ident, writeSignedCommit, writeTreeFromIndex } from "../git/commit.js";
import { readLog } from "../git/log-reader.js";
import { GitError, type GitRunner } from "../git/runner.js";
import type { Signer } from "../git/signer.js";
import { backoffDelay } from "../util/backoff.js";
import { type Clock, isoUtc } from "../util/clock.js";
import { newEventId, type RandomSource } from "../util/random.js";
import type { BlackboardClone } from "./clone.js";

const cloneQueues = new Map<string, Promise<void>>();
const heldClones = new AsyncLocalStorage<ReadonlySet<string>>();

/** F12: a publisher may call Sync.replayTo while holding this same clone lock (§7.2). */
export function withCloneLock<T>(
  clone: Pick<BlackboardClone, "dir">,
  work: () => Promise<T>,
): Promise<T> {
  const key = resolve(clone.dir);
  const held = heldClones.getStore();
  if (held?.has(key)) return work();
  const result = (cloneQueues.get(key) ?? Promise.resolve()).then(() =>
    heldClones.run(new Set([...(held ?? []), key]), work),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  cloneQueues.set(key, tail);
  void tail.then(() => {
    if (cloneQueues.get(key) === tail) cloneQueues.delete(key);
  });
  return result;
}

export interface StateSource {
  replayTo(tip: Sha): Promise<State>;
}

export function fullReplaySource(git: GitRunner, dir: string, trustPath: string): StateSource {
  return {
    replayTo: async (tip) => replay(await readLog(git, dir, trustPath, { ref: tip })),
  };
}

/**
 * Non-GitError failures inside the write loop return "failed" immediately (fail closed). An
 * observation failure after a successful push may leave the event committed despite that status.
 * Recover by publishing with the same eventId to consult seen_event_ids (ARCHITECTURE §7.2, §11.4).
 */
export interface PublishResult {
  status: "accepted" | "rejected" | "dropped" | "failed";
  seq?: number;
  reason?: string;
  eventId: EventId;
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

interface PublisherDeps {
  git: GitRunner;
  clone: BlackboardClone;
  signer: Signer;
  clock: Clock;
  rng: RandomSource;
  state: StateSource;
  ident: Ident;
  maxAttempts?: number;
}

export class Publisher {
  private readonly maxAttempts: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PublisherDeps) {
    this.maxAttempts = deps.maxAttempts ?? 8;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new PublishError("maxAttempts must be a positive safe integer");
    }
  }

  /**
   * Persist eventId with the intent before publishing for restart recovery (ARCHITECTURE §11.4).
   * Invalid event IDs throw PublishError before queueing.
   */
  publish(intent: Intent, opts?: { signer?: Signer; eventId?: EventId }): Promise<PublishResult> {
    const eventId = opts?.eventId === undefined ? newEventId(this.deps.rng) : opts.eventId;
    const parsed = EventIdSchema.safeParse(eventId);
    // The shared regex's '$' also matches before a final line terminator; require the entire ID.
    if (!parsed.success || parsed.data !== parsed.data.trim()) {
      throw new PublishError(
        "eventId must match the evt_<UUID> format without surrounding whitespace",
      );
    }
    const signer = opts?.signer ?? this.deps.signer;
    const result = this.tail.then(() => this.run(intent, eventId, signer));
    // A failing callback must not poison the FIFO for every subsequent local intent (§7.2).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async observe(): Promise<State> {
    await this.deps.clone.fetch();
    const tip = await this.deps.clone.resetToRemoteMain();
    const state = await this.deps.state.replayTo(tip);
    if (state.tip !== tip)
      throw new PublishError(`State source did not replay requested tip ${tip}`);
    return state;
  }

  private seenResult(state: State, eventId: EventId): PublishResult | null {
    if (!Object.hasOwn(state.seen_event_ids, eventId)) return null;
    const seq = state.seen_event_ids[eventId];
    const outcome = state.outcomes.find((entry) => entry.seq === seq && entry.event_id === eventId);
    if (!outcome) throw new PublishError(`No reducer outcome for seen event ${eventId} at ${seq}`);
    return this.outcomeResult(outcome, eventId);
  }

  private outcomeResult(outcome: LogOutcome, eventId: EventId): PublishResult {
    if (outcome.outcome === "accepted" || outcome.outcome === "rejected") {
      return {
        status: outcome.outcome,
        seq: outcome.seq,
        eventId,
        ...(outcome.reason === null ? {} : { reason: outcome.reason }),
      };
    }
    return {
      status: "failed",
      seq: outcome.seq,
      eventId,
      reason: `Published commit is ${outcome.outcome}: ${outcome.reason ?? "no reducer reason"}`,
    };
  }

  private async run(intent: Intent, eventId: EventId, signer: Signer): Promise<PublishResult> {
    let lastError = "No publish attempt completed";
    let pendingSha: Sha | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await withCloneLock(this.deps.clone, async () => {
          const state = await this.observe();
          const seen = this.seenResult(state, eventId);
          if (seen) return seen;
          // D3 excludes unauthorized/invalid events from seen IDs. A known landed SHA still lets
          // us report that failure after a lost acknowledgement without appending it again.
          const landed = state.outcomes.find((outcome) => outcome.sha === pendingSha);
          if (landed) return this.outcomeResult(landed, eventId);
          const eventDraft = intent(state);
          if (eventDraft === null) return { status: "dropped", eventId };
          const nowMs = this.deps.clock.nowMs();
          const event = finalizeEvent(eventDraft, {
            event_id: eventId,
            observed_tip: state.tip,
            created_at: isoUtc(nowMs),
          });
          const path = eventPath(event.task_id, eventId);
          if (parseEventPath(path) === null) throw new PublishError(`Invalid event path ${path}`);
          const content = serializeEvent(event);
          if (Buffer.byteLength(content, "utf8") > MAX_EVENT_BYTES) {
            throw new PublishError(`Event ${eventId} exceeds ${MAX_EVENT_BYTES} bytes`);
          }
          const file = join(this.deps.clone.dir, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content, { flag: "wx", mode: 0o600 });
          try {
            await this.deps.git.run(["add", "--", path], { cwd: this.deps.clone.dir });
          } catch (error) {
            // A failed add can leave an untracked file that reset --hard will not discard (§7.2).
            await rm(file, { force: true });
            throw error;
          }
          const ident = { ...this.deps.ident, timestampSec: Math.floor(nowMs / 1000) };
          pendingSha = await writeSignedCommit(this.deps.git, this.deps.clone.dir, {
            tree: await writeTreeFromIndex(this.deps.git, this.deps.clone.dir),
            parents: [state.tip],
            author: ident,
            committer: ident,
            message: `${event.type} ${event.task_id ?? "_skep"} ${eventId}`,
            signer,
          });
          await this.deps.git.run(["update-ref", "refs/heads/main", pendingSha, state.tip], {
            cwd: this.deps.clone.dir,
          });
          await this.deps.git.run(["push", "origin", `${pendingSha}:refs/heads/main`], {
            cwd: this.deps.clone.dir,
          });
          const observed = await this.observe();
          const result = this.seenResult(observed, eventId);
          if (result) return result;
          const outcome = observed.outcomes.find((entry) => entry.sha === pendingSha);
          if (!outcome)
            throw new PublishError(`Pushed commit ${pendingSha} is absent from remote main`);
          return this.outcomeResult(outcome, eventId);
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!(error instanceof GitError)) return { status: "failed", eventId, reason: lastError };
      }
      if (attempt + 1 < this.maxAttempts) {
        await this.deps.clock.sleep(backoffDelay(attempt, this.deps.rng));
      }
    }
    return {
      status: "failed",
      eventId,
      reason: `Publishing failed after ${this.maxAttempts} attempts: ${lastError}`,
    };
  }
}
