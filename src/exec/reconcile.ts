import { z } from "zod";
import type { PublishResult } from "../blackboard/publisher.js";
import type { PrInfo } from "../codehost/types.js";
import { contentHash } from "../core/canonical.js";
import { workBranch } from "../core/ids.js";
import type { State } from "../core/reducer/state.js";
import {
  AgentIdSchema,
  AttemptIdSchema,
  EpochSchema,
  ItemIdSchema,
  ShaSchema,
  TaskIdSchema,
} from "../core/schemas/common.js";
import { PlanSchema } from "../core/schemas/plan.js";
import { SnapshotSchema } from "../core/schemas/snapshot.js";
import { readStartToken } from "../runtime/native.js";
import { cryptoRandom, newEventId } from "../util/random.js";
import {
  type AttemptInput,
  type AttemptPublication,
  AttemptPublicationSchema,
  type AttemptResult,
  AttemptRunner,
  type AttemptRunnerDependencies,
} from "./attempt.js";
import { type AttemptKey, type Journal, type JournalRecord, TERMINAL_STEPS } from "./journal.js";

const InputSchema = z.strictObject({
  lease: z.strictObject({
    task_id: TaskIdSchema,
    item: ItemIdSchema,
    epoch: EpochSchema,
    holder: AgentIdSchema,
  }),
  attemptId: AttemptIdSchema,
  plan: PlanSchema,
  baseSha: ShaSchema,
  prBase: z.string().min(1).max(255),
  agentInstructions: z.string(),
  repoContext: z.string(),
  timeoutMs: z.number().finite().positive(),
  cliVersion: z.string().min(1).optional(),
});
const ProcessSchema = z.object({
  pid: z.number().int().positive().max(2_147_483_647),
  pgid: z.number().int().positive().max(2_147_483_647),
  start_token: z.string(),
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
  killGroup(pgid: number): Promise<void>;
}

export const nativeReconcileProcesses: ReconcileProcesses = {
  startToken: readStartToken,
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
    if (!pending && (interrupted || !claimed || unknownOutcome(records))) {
      const publication = this.unknownPublication(input, lease.interrupt);
      await this.deps.journal.append(key, { step: "publish_pending", publication });
    } else if (pending?.type === "work.delivered" && interrupted) {
      // Preserve a pending event id. Its fenced intent drops rather than becoming a new event.
      return this.stale(key);
    }

    if (!interrupted && (!pending || pending.type === "work.delivered")) {
      if (!(await this.checkPr(input, records, pending))) return this.stale(key);
    }
    // SK-504 resolves remote push/PR lost acknowledgements and scans before every publication.
    return new AttemptRunner(this.deps).run(input);
  }

  private input(key: AttemptKey, value: unknown): AttemptInput {
    const parsed = InputSchema.safeParse(value);
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
      const { pid, pgid, start_token: token } = parsed.data;
      const identity = `${pgid}/${token}`;
      if (stopped.has(identity)) continue;
      const actual = token === "" ? null : await processes.startToken(pid);
      // A nonempty different token proves PID reuse. Never signal that unrelated new group.
      if (token !== "" && actual !== null && actual !== token) {
        await this.deps.journal.append(key, { step: "process_reused", pgid });
      } else {
        // Empty/missing leader metadata cannot rule out orphan children: kill anyway (F19).
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
  ): Promise<boolean> {
    const saved = records.findLast((record) => record.step === "pr");
    const pr: PrInfo | null = saved ? PrSchema.parse(saved.pr) : null;
    const number =
      pr?.number ?? (pending?.type === "work.delivered" ? pending.payload.pr_number : null);
    if (number === null) return true;
    if (pr && pr.head !== workBranch(input.lease.task_id, input.lease.item, input.lease.epoch)) {
      throw new ReconcileError("Journaled PR head differs from the attempt branch");
    }
    // G10: findPr only lists open PRs; a saved number must be checked first, even after merge.
    const current = PrStateSchema.parse(
      await this.deps.codeHost.prState(input.plan.base.repo, number),
    );
    return current.state === "open";
  }

  private unknownPublication(input: AttemptInput, barrierId: string | null): AttemptPublication {
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
              detail: "Outcome is unknown after restart; do not rerun the invocation",
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
