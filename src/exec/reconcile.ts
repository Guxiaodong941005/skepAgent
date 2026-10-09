import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type { PublishResult } from "../blackboard/publisher.js";
import type { PrInfo } from "../codehost/types.js";
import { contentHash } from "../core/canonical.js";
import { workBranch } from "../core/ids.js";
import type { State } from "../core/reducer/state.js";
import { ShaSchema } from "../core/schemas/common.js";
import { SnapshotSchema } from "../core/schemas/snapshot.js";
import { readStartToken } from "../runtime/native.js";
import { cryptoRandom, newEventId } from "../util/random.js";
import {
  type AttemptInput,
  AttemptInputSchema,
  type AttemptPublication,
  AttemptPublicationSchema,
  type AttemptResult,
  AttemptRunner,
  type AttemptRunnerDependencies,
} from "./attempt.js";
import { type AttemptKey, type Journal, type JournalRecord, TERMINAL_STEPS } from "./journal.js";

const ProcessSchema = z.object({
  pid: z.number().int().positive().max(2_147_483_647),
  pgid: z.number().int().positive().max(2_147_483_647),
  start_token: z.string(),
  boot_id: z.string().min(1).optional(),
});
const PrSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.url().max(512),
  head: z.string().min(1),
  base: z.string().min(1),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  mergeSha: ShaSchema.nullable(),
});
const PrStateSchema = z.strictObject({
  state: z.enum(["open", "closed", "merged"]),
  mergeSha: ShaSchema.nullable(),
});

/** Separate I/O port because RuntimeBackend cannot signal a group from an earlier daemon. */
export interface ReconcileProcesses {
  startToken(pid: number): Promise<string | null>;
  /** OS boot identity, shared across daemon restarts; never the heartbeat's daemon boot_id. */
  bootId?(): Promise<string | null>;
  killGroup(pgid: number): Promise<void>;
}

export const nativeReconcileProcesses: ReconcileProcesses = {
  startToken: readStartToken,
  async bootId() {
    try {
      if (platform() === "linux") {
        return z.uuid().parse((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
      }
      if (platform() === "darwin") {
        const { stdout } = await promisify(execFile)(
          "/usr/sbin/sysctl",
          ["-n", "kern.bootsessionuuid"],
          { shell: false, encoding: "utf8" },
        );
        return z.uuid().parse(stdout.trim());
      }
      return null;
    } catch (cause) {
      throw new ReconcileError("Cannot read the OS boot identity; inspect process supervision", {
        cause,
      });
    }
  },
  async killGroup(pgid) {
    if (!ProcessSchema.shape.pgid.safeParse(pgid).success) {
      throw new ReconcileError("Cannot signal an invalid recorded process group");
    }
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      // A leader may already be gone while its children still need the group signal (F19).
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new ReconcileError("Cannot kill the recorded process group; repair supervision", {
          cause: error,
        });
      }
    }
  },
};

export interface ReconcileDependencies extends AttemptRunnerDependencies {
  journal: Pick<Journal, "append" | "read" | "path" | "unfinishedAttempts">;
  /** Must perform a fresh full observation; hints and cached state cannot authorize recovery. */
  observeNow(): Promise<State>;
  processes?: ReconcileProcesses;
}

export interface ReconciledAttempt {
  key: AttemptKey;
  result: AttemptResult;
}

export class ReconcileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReconcileError";
  }
}

/** Restart policy: terminate rather than re-adopt; never guess an invocation's result (§11.4). */
export class AttemptReconciler {
  private running = false;

  constructor(private readonly deps: ReconcileDependencies) {}

  async reconcile(): Promise<ReconciledAttempt[]> {
    if (this.running) throw new ReconcileError("Restart reconciliation is already running");
    this.running = true;
    try {
      await this.deps.observeNow();
      const results: ReconciledAttempt[] = [];
      for (const key of await this.deps.journal.unfinishedAttempts()) {
        results.push({ key, result: await this.recover(key) });
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private async recover(key: AttemptKey): Promise<AttemptResult> {
    const records = await this.deps.journal.read(key);
    if ((TERMINAL_STEPS as readonly string[]).includes(records.at(-1)?.step ?? "")) {
      throw new ReconcileError("Attempt became terminal during reconciliation; stop other writers");
    }
    await this.stopProcesses(key, records);
    const state = await this.deps.observeNow();
    const pendingRecord = records.findLast((record) => record.step === "publish_pending");
    const pending = pendingRecord
      ? AttemptPublicationSchema.parse(pendingRecord.publication)
      : null;
    if (pending && (pending.payload.item !== key.item || pending.payload.epoch !== key.epoch)) {
      throw new ReconcileError("Pending publication does not match the journaled attempt");
    }
    if (pending && Object.hasOwn(state.seen_event_ids, pending.event_id)) {
      // F17: acknowledge the exact saved id even when its accepted event ended the lease.
      const outcome = await this.deps.publisher.publish(() => null, { eventId: pending.event_id });
      return this.finish(key, pending, outcome);
    }

    const claimed = records.findLast((record) => record.step === "claimed");
    const input = claimed ? this.input(key, claimed.input) : this.reconstruct(key, state);
    if (!input) return this.stale(key);
    const task = state.tasks[key.task];
    const lease = task?.items[key.item]?.lease;
    if (
      !lease ||
      lease.epoch !== key.epoch ||
      lease.holder !== input.lease.holder ||
      lease.attempt_id !== input.attemptId ||
      lease.plan_version !== input.plan.version ||
      lease.plan_hash !== contentHash(input.plan)
    ) {
      return this.stale(key);
    }

    // A barrier fences delivery, but its holder must still settle it (D16, §5.5).
    const interrupted = lease.interrupt !== null;
    if (!interrupted && (await this.deps.reverify(input.lease)) !== "ok") return this.stale(key);
    if (interrupted && !["interrupting", "replanning", "escalated"].includes(task.status)) {
      return this.stale(key);
    }
    let replacement: AttemptPublication | null = null;
    if (
      (!pending && (interrupted || !claimed || unknownOutcome(records))) ||
      (pending?.type === "work.delivered" && interrupted)
    ) {
      replacement = this.unknownPublication(input, lease.interrupt);
    } else if (
      !interrupted &&
      (!pending || pending.type === "work.delivered") &&
      ["pr", "mr"].includes(
        pending?.type === "work.delivered"
          ? pending.payload.submit.method
          : input.submit.host === "git"
            ? "push"
            : input.submit.method,
      )
    ) {
      const prState = await this.checkPr(input, records, pending);
      if (prState !== "open") {
        replacement = this.unknownPublication(
          input,
          null,
          `PR was ${prState} before work.delivered; inspect the PR before retrying`,
        );
      }
    }
    if (replacement) {
      // Retain the old delivery id for acknowledgement, but journal a distinct fenced outcome
      // before publishing it (F17, §11.4). A retry resumes this new id after an outage.
      await this.deps.journal.append(key, { step: "publish_pending", publication: replacement });
    }
    // SK-504 resolves remote push/PR lost acknowledgements and scans before every publication.
    return new AttemptRunner(this.deps).run(input);
  }

  private input(key: AttemptKey, value: unknown): AttemptInput {
    const parsed = AttemptInputSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.lease.task_id !== key.task ||
      parsed.data.lease.item !== key.item ||
      parsed.data.lease.epoch !== key.epoch ||
      parsed.data.plan.task_id !== key.task
    ) {
      throw new ReconcileError("Journaled input does not match the attempt; repair the journal");
    }
    return parsed.data;
  }

  private reconstruct(key: AttemptKey, state: State): AttemptInput | null {
    const task = state.tasks[key.task];
    const lease = task?.items[key.item]?.lease;
    const plan = task?.plans[String(lease?.plan_version)]?.plan;
    if (!lease || lease.epoch !== key.epoch || !plan) return null;
    const index = plan.stack_order.indexOf(key.item);
    const previous = plan.stack_order[index - 1];
    const delivery = previous ? task?.items[previous]?.delivered : null;
    if (index < 0 || (previous && !delivery)) {
      throw new ReconcileError("Cannot recover the stacked attempt base from the approved plan");
    }
    return this.input(key, {
      lease: { task_id: key.task, item: key.item, epoch: key.epoch, holder: lease.holder },
      attemptId: lease.attempt_id,
      plan,
      baseSha: delivery?.head_sha ?? plan.base.commit,
      prBase: delivery?.branch ?? plan.base.branch,
      agentInstructions: "",
      repoContext: "",
      timeoutMs: 1,
    });
  }

  private async stopProcesses(key: AttemptKey, records: JournalRecord[]): Promise<void> {
    const processes = this.deps.processes ?? nativeReconcileProcesses;
    const stopped = new Set<string>();
    for (const record of records) {
      if (!["invoked", "check_started"].includes(record.step) || record.pgid === null) continue;
      const parsed = ProcessSchema.safeParse(record);
      if (!parsed.success) {
        throw new ReconcileError("Invalid journaled process identity; repair the journal");
      }
      const { pid, pgid, start_token: token, boot_id: bootId } = parsed.data;
      const identity = JSON.stringify([pgid, token, bootId]);
      if (stopped.has(identity)) continue;
      if (token === "") {
        // PRD §10.6: an empty token alone cannot distinguish orphans from a reused group
        // after reboot. Older journals lack this evidence, so leave those groups untouched.
        const currentBoot = bootId ? await processes.bootId?.() : null;
        if (!bootId || !currentBoot || currentBoot !== bootId) {
          await this.deps.journal.append(key, {
            step: "process_unverified",
            pgid,
            reason:
              currentBoot && currentBoot !== bootId ? "boot_changed" : "missing_boot_identity",
          });
          stopped.add(identity);
          continue;
        }
      }
      const actual = await processes.startToken(token === "" ? pgid : pid);
      // A nonempty different token proves PID reuse. Never signal that unrelated new group.
      if (actual !== null && actual !== token) {
        await this.deps.journal.append(key, { step: "process_reused", pgid });
      } else {
        // A missing leader can leave orphan children within the proven boot (F19).
        await processes.killGroup(pgid);
        await this.deps.journal.append(key, { step: "process_terminated", pgid });
      }
      stopped.add(identity);
    }
  }

  private async checkPr(
    input: AttemptInput,
    records: JournalRecord[],
    pending: AttemptPublication | null,
  ): Promise<"open" | "closed" | "merged"> {
    const saved = records.findLast((record) => record.step === "pr");
    const pr: PrInfo | null = saved ? PrSchema.parse(saved.pr) : null;
    const number =
      pr?.number ??
      (pending?.type === "work.delivered" ? (pending.payload.submit.pr_number ?? null) : null);
    if (number === null) return "open";
    if (pr && pr.head !== workBranch(input.lease.task_id, input.lease.item, input.lease.epoch)) {
      throw new ReconcileError("Journaled PR head differs from the attempt branch");
    }
    // G10: findPr only lists open PRs; a saved number must be checked first, even after merge.
    const current = PrStateSchema.parse(
      await this.deps.codeHost.prState(input.plan.base.repo, number),
    );
    return current.state;
  }

  private unknownPublication(
    input: AttemptInput,
    barrierId: string | null,
    detail = "Outcome is unknown after restart; do not rerun the invocation",
  ): AttemptPublication {
    const { item, epoch } = input.lease;
    const event_id = newEventId(this.deps.random ?? cryptoRandom);
    return AttemptPublicationSchema.parse(
      barrierId === null
        ? {
            type: "work.failed",
            event_id,
            payload: {
              item,
              epoch,
              class: "crash",
              detail,
            },
          }
        : {
            type: "checkpoint.recorded",
            event_id,
            payload: {
              item,
              epoch,
              barrier_id: barrierId,
              snapshot: SnapshotSchema.parse({
                schema: "skep.snapshot/v1",
                item,
                epoch,
                attempt_id: input.attemptId,
                branch: workBranch(input.lease.task_id, item, epoch),
                base_sha: input.baseSha,
                head_sha: null,
                pushed: false,
                invocation_state: "unknown",
                diffstat: { files: 0, insertions: 0, deletions: 0 },
                files_changed: [],
                check_runs: [],
                agent_note: null,
              }),
            },
          },
    );
  }

  private async stale(key: AttemptKey): Promise<AttemptResult> {
    const result = { status: "stale" } as const;
    await this.deps.journal.append(key, { step: "stale", result });
    return result;
  }

  private async finish(
    key: AttemptKey,
    publication: AttemptPublication,
    outcome: PublishResult,
  ): Promise<AttemptResult> {
    if (outcome.status === "failed") return { status: "pending", publication: outcome };
    if (outcome.status !== "accepted") return this.stale(key);
    const result: AttemptResult =
      publication.type === "work.delivered"
        ? { status: "delivered", publication: outcome }
        : publication.type === "checkpoint.recorded"
          ? { status: "checkpointed", snapshot: publication.payload.snapshot, publication: outcome }
          : { status: "failed", class: publication.payload.class, publication: outcome };
    const step = publication.type === "work.delivered" ? "delivered_published" : result.status;
    await this.deps.journal.append(key, {
      step,
      seq: outcome.seq,
      event_id: publication.event_id,
      result,
    });
    return result;
  }
}

function unknownOutcome(records: JournalRecord[]): boolean {
  const lastIndex = (step: string, phase?: string) =>
    records.findLastIndex(
      (record) => record.step === step && (phase === undefined || record.phase === phase),
    );
  if (lastIndex("fixup") > lastIndex("fixup_done")) return true;
  const invoked = Math.max(lastIndex("invoked"), lastIndex("invocation_started"));
  if (invoked > Math.max(lastIndex("invocation_done"), lastIndex("fixup_done"))) return true;
  for (const phase of ["work", "fixup"]) {
    if (lastIndex("checks_started", phase) > lastIndex("checks", phase)) return true;
  }
  return false;
}
