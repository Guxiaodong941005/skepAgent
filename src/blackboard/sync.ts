import { z } from "zod";
import type { Sha } from "../core/ids.js";
import { applyEntry, replay } from "../core/reducer/replay.js";
import { type LogOutcome, type State, TERMINAL_TASK_STATUSES } from "../core/reducer/state.js";
import { ShaSchema } from "../core/schemas/common.js";
import { LogReadError, readLog } from "../git/log-reader.js";
import type { GitRunner } from "../git/runner.js";
import { NullHintChannel } from "../transport/null-hint.js";
import { type Hint, type HintChannel, HintSchema } from "../transport/types.js";
import { backoffDelay } from "../util/backoff.js";
import type { Clock } from "../util/clock.js";
import type { RandomSource } from "../util/random.js";
import type { BlackboardClone } from "./clone.js";
import type { StateSource } from "./publisher.js";

export class SyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncError";
  }
}

export interface SyncIntervals {
  activeMs: number;
  idleMs: number;
  jitter: number;
  minHintGapMs: number;
}

export interface SyncSnapshot {
  state: State | null;
  tip: Sha | null;
  seq: number | null;
  /** Last successful remote observation, including an unchanged ls-remote response (§17.3). */
  fetchedAtMonoMs: number | null;
  invalidCount: number;
}

export type SyncAlarm =
  | { kind: "log_read"; error: LogReadError }
  | { kind: "invalid_commit"; outcome: LogOutcome }
  | { kind: "sync_failed" | "hint_failed"; error: SyncError };

interface SyncDeps {
  git: GitRunner;
  clone: BlackboardClone;
  trustPath: string;
  clock: Clock;
  rng: RandomSource;
  hints?: HintChannel;
  intervals?: Partial<SyncIntervals>;
}

const IntervalsSchema = z
  .strictObject({
    activeMs: z.number().positive().default(20_000),
    idleMs: z.number().positive().default(90_000),
    jitter: z.number().min(0).lt(1).default(0.25),
    // D18's load bound must hold even with caller-supplied intervals (§17.4).
    minHintGapMs: z.number().min(2_000).default(2_000),
  })
  .refine((intervals) => intervals.idleMs >= intervals.activeMs, {
    message: "idleMs must be at least activeMs",
  });

const RefRecordSchema = z.tuple([
  ShaSchema,
  z.string().regex(/^refs\/heads\/(?:main|hb\/[^\s\0]+)$/),
]);

function refsSnapshot(output: string, local: boolean): { main: Sha; key: string } {
  const refs: Record<string, Sha> = {};
  for (const line of output.trimEnd().split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (local && fields[1]?.startsWith("refs/remotes/origin/")) {
      fields[1] = fields[1].replace("refs/remotes/origin/", "refs/heads/");
    }
    const parsed = RefRecordSchema.safeParse(fields);
    if (!parsed.success) throw new SyncError("Invalid main/hb ref response from git");
    const [sha, ref] = parsed.data;
    if (Object.hasOwn(refs, ref)) throw new SyncError(`Duplicate blackboard ref ${ref}`);
    refs[ref] = sha;
  }
  const main = refs["refs/heads/main"];
  if (!main) throw new SyncError("Blackboard main is missing; create a human-signed genesis");
  return { main, key: JSON.stringify(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b))) };
}

export class Sync implements StateSource {
  private readonly hints: HintChannel;
  private readonly intervals: SyncIntervals;
  private state: State | null = null;
  private fetchedAtMonoMs: number | null = null;
  private fetchedRefsKey: string | null = null;
  private invalidCount = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly stateListeners = new Set<(state: State) => void>();
  private readonly alarmListeners = new Set<(alarm: SyncAlarm) => void>();
  private controller: AbortController | null = null;
  private sleeper: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private cycling = false;
  private hintPending = false;
  private lastHintCycleAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: SyncDeps) {
    this.hints = deps.hints ?? new NullHintChannel();
    const parsed = IntervalsSchema.safeParse(deps.intervals ?? {});
    if (!parsed.success) {
      throw new SyncError(`Invalid sync intervals: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    this.intervals = parsed.data;
  }

  current(): SyncSnapshot {
    return {
      state: this.state === null ? null : structuredClone(this.state),
      tip: this.state?.tip ?? null,
      seq: this.state?.seq ?? null,
      fetchedAtMonoMs: this.fetchedAtMonoMs,
      invalidCount: this.invalidCount,
    };
  }

  onState(cb: (state: State) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onAlarm(cb: (alarm: SyncAlarm) => void): () => void {
    this.alarmListeners.add(cb);
    return () => this.alarmListeners.delete(cb);
  }

  replayTo(tip: Sha): Promise<State> {
    return this.enqueue(async () => {
      const requestedTip = ShaSchema.parse(tip);
      const cached = this.state;
      // A publisher's fetched tip can precede a concurrent poll's cache update (§7.2).
      // Historical snapshots must not report a rewrite or regress the current observation.
      if (
        cached &&
        cached.tip !== requestedTip &&
        (cached.genesis_sha === requestedTip ||
          cached.outcomes.some((outcome) => outcome.sha === requestedTip))
      ) {
        return structuredClone(await this.fullReplay(requestedTip));
      }
      return structuredClone(await this.readState(requestedTip));
    });
  }

  /** A delivery re-verification always fetches, even when the polling shortcut could apply. */
  observeNow(): Promise<State> {
    return this.enqueue(async () => structuredClone(await this.observe(true)));
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.startup) return this.startup;
    const controller = new AbortController();
    this.controller = controller;
    this.startup = new Promise<void>((ready) => {
      this.loop = this.run(controller, ready);
    });
    return this.startup;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.controller) return Promise.resolve();
    this.controller.abort();
    this.sleeper?.abort();
    this.stopping = this.finishStop();
    return this.stopping;
  }

  private async finishStop(): Promise<void> {
    try {
      await this.loop;
      await this.hints.stop();
    } catch (error) {
      this.alarm("hint_failed", "Could not stop the sync hint channel", error);
    } finally {
      this.controller = null;
      this.loop = null;
      this.startup = null;
      this.stopping = null;
      this.hintPending = false;
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    // A failed observation must not poison subsequent publisher or poller observations (§7.2).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readState(tip: Sha): Promise<State> {
    const previous = this.state;
    if (previous?.tip === tip) return previous;
    let next: State;
    if (previous) {
      try {
        const entries = await readLog(this.deps.git, this.deps.clone.dir, this.deps.trustPath, {
          ref: tip,
          from: { sha: previous.tip, seq: previous.seq },
        });
        next = entries.reduce(applyEntry, previous);
      } catch (error) {
        if (!(error instanceof LogReadError)) throw error;
        this.emitAlarm({ kind: "log_read", error });
        next = await this.fullReplay(tip);
      }
    } else {
      next = await this.fullReplay(tip);
    }
    if (next.tip !== tip) throw new SyncError(`Replay did not reach requested tip ${tip}`);
    const knownInvalid = new Set(
      previous?.outcomes.filter((outcome) => outcome.outcome === "invalid").map((o) => o.sha),
    );
    const invalid = next.outcomes.filter((outcome) => outcome.outcome === "invalid");
    this.state = next;
    this.invalidCount = invalid.length;
    for (const outcome of invalid) {
      if (!knownInvalid.has(outcome.sha)) {
        this.emitAlarm({ kind: "invalid_commit", outcome: structuredClone(outcome) });
      }
    }
    for (const cb of this.stateListeners) {
      try {
        cb(structuredClone(next));
      } catch (error) {
        this.alarm("sync_failed", "Could not notify a sync state listener", error);
      }
    }
    return next;
  }

  private async fullReplay(tip: Sha): Promise<State> {
    const state = replay(
      await readLog(this.deps.git, this.deps.clone.dir, this.deps.trustPath, { ref: tip }),
    );
    if (state.tip !== tip) throw new SyncError(`Replay did not reach requested tip ${tip}`);
    return state;
  }

  private async observe(force: boolean): Promise<State> {
    if (!force) {
      const { stdout } = await this.deps.git.run(
        ["ls-remote", "--heads", "origin", "refs/heads/main", "refs/heads/hb/*"],
        { cwd: this.deps.clone.dir },
      );
      const advertised = refsSnapshot(stdout, false);
      if (this.state?.tip === advertised.main && this.fetchedRefsKey === advertised.key) {
        this.fetchedAtMonoMs = this.deps.clock.monotonicMs();
        return this.state;
      }
    }
    await this.deps.clone.fetch();
    // Read the fetched refs, not the earlier advertisement: main/hb can move during fetch.
    // Sync never resets HEAD, which belongs to the publisher's write loop (§7.2).
    const { stdout } = await this.deps.git.run(
      [
        "for-each-ref",
        "--format=%(objectname)%09%(refname)",
        "refs/remotes/origin/main",
        "refs/remotes/origin/hb/",
      ],
      { cwd: this.deps.clone.dir },
    );
    const fetched = refsSnapshot(stdout, true);
    const state = await this.readState(fetched.main);
    this.fetchedRefsKey = fetched.key;
    this.fetchedAtMonoMs = this.deps.clock.monotonicMs();
    return state;
  }

  private receiveHint(hint: Hint): void {
    const parsed = HintSchema.safeParse(hint);
    if (
      !parsed.success ||
      parsed.data.kind !== "tip" ||
      this.controller?.signal.aborted !== false
    ) {
      return;
    }
    // Hints coalesce into an observation already in progress; their SHA is never followed (§17.2).
    if (this.cycling || this.hintPending) return;
    if (this.deps.clock.monotonicMs() - this.lastHintCycleAt < this.intervals.minHintGapMs) return;
    this.hintPending = true;
    this.sleeper?.abort();
  }

  private intervalMs(): number {
    // No device identity is supplied by the Sync contract, so any unfinished task keeps polling
    // active. The daemon may supply its configured intervals (§11.1).
    const active = Object.values(this.state?.tasks ?? {}).some(
      (task) => !TERMINAL_TASK_STATUSES.includes(task.status),
    );
    const baseMs = active ? this.intervals.activeMs : this.intervals.idleMs;
    return backoffDelay(0, this.deps.rng, {
      baseMs,
      maxMs: baseMs * (1 + this.intervals.jitter),
      jitter: this.intervals.jitter,
    });
  }

  private async run(controller: AbortController, ready: () => void): Promise<void> {
    try {
      try {
        await this.hints.start((hint) => this.receiveHint(hint));
      } catch (error) {
        this.alarm(
          "hint_failed",
          "Could not start the sync hint channel; polling continues",
          error,
        );
      }
      while (!controller.signal.aborted) {
        const hinted = this.hintPending;
        this.hintPending = false;
        this.cycling = true;
        try {
          await this.enqueue(async () => {
            if (controller.signal.aborted) return;
            if (hinted) this.lastHintCycleAt = this.deps.clock.monotonicMs();
            await this.observe(false);
          });
        } catch (error) {
          this.alarm("sync_failed", "Could not observe the blackboard; polling will retry", error);
        } finally {
          this.cycling = false;
        }
        ready();
        if (controller.signal.aborted) break;
        if (this.hintPending) continue;
        const sleeper = new AbortController();
        this.sleeper = sleeper;
        try {
          await this.deps.clock.sleep(this.intervalMs(), sleeper.signal);
        } catch (error) {
          if (!sleeper.signal.aborted) throw error;
        } finally {
          this.sleeper = null;
        }
      }
    } catch (error) {
      this.alarm("sync_failed", "Sync polling stopped unexpectedly", error);
    } finally {
      ready();
    }
  }

  private alarm(kind: "sync_failed" | "hint_failed", message: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.emitAlarm({ kind, error: new SyncError(`${message}: ${detail}`, { cause }) });
  }

  private emitAlarm(alarm: SyncAlarm): void {
    for (const cb of this.alarmListeners) cb(alarm);
  }
}
