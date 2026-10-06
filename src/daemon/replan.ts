import type { Publisher, PublishResult } from "../blackboard/publisher.js";
import { checkpointIntent, draft, type Intent } from "../core/intents.js";
import { isSettled } from "../core/reducer/handlers/barrier.js";
import type { State, TaskState } from "../core/reducer/state.js";
import { EVENT_SCHEMAS } from "../core/schemas/events.js";
import { SnapshotSchema } from "../core/schemas/snapshot.js";
import { WorkReportSchema } from "../core/schemas/work-report.js";
import type { AttemptRunner } from "../exec/attempt.js";
import type { EvidenceVerifier } from "../exec/evidence.js";
import type { AttemptKey, Journal } from "../exec/journal.js";
import { findSecrets, Redactor } from "../exec/redact.js";
import type { Clock } from "../util/clock.js";
import type { Slot } from "./slots.js";

export interface ReplanDutyDependencies {
  clock: Clock;
  journal(slot: Slot): Journal;
  notify(message: string): Promise<void>;
}

/** Interruption and code-first checkpoints stay with the attempt's single journal writer. */
export interface ReplanDutyContext {
  state: State;
  task: TaskState;
  slot: Slot;
  nowMonoMs: number;
  publisher: { publish(intent: Intent): Promise<unknown> };
  attempt: Pick<AttemptRunner, "interrupt">;
}
export type ReplanDuty = (context: ReplanDutyContext) => Promise<void>;

export const BARRIER_DEADLINE_MS = 20 * 60_000;

export class ReplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplanError";
  }
}

function makeDuty(deps?: ReplanDutyDependencies): ReplanDuty {
  const observed = new Map<string, number>();
  const interrupted = new Set<string>();
  const notified = new Set<string>();
  const redactor = new Redactor();
  return async (context) => {
    const { task, slot, publisher } = context;
    const barrier = task.barrier;
    if (!barrier || ["done", "cancelled"].includes(task.status)) return;
    const key = `${slot.roleDir}:${task.task_id}:${task.owner_gen}:${barrier.id}`;
    const now = deps?.clock.monotonicMs() ?? context.nowMonoMs;
    if (task.owner === slot.agent && barrier.closed_seq === null) {
      // §11.1: replay contains seqs, not a trusted clock timestamp. Start at the owner's first
      // observation; a restart/ownership transfer grants a fresh conservative monotonic deadline.
      const since = observed.get(key) ?? now;
      observed.set(key, since);
      if (task.status === "interrupting" && now - since >= BARRIER_DEADLINE_MS) {
        await publisher.publish((latest) => {
          const current = latest.tasks[task.task_id];
          const open = current?.barrier;
          if (
            current?.status !== "interrupting" ||
            current.owner !== slot.agent ||
            current.owner_gen !== task.owner_gen ||
            open?.id !== barrier.id ||
            open.closed_seq !== null
          )
            return null;
          // The write loop may observe another checkpoint/revoke after this tick (§7.2).
          return draft(
            "barrier.closed",
            task.task_id,
            slot.agent,
            { barrier_id: open.id, missing: open.awaiting.filter((id) => !isSettled(current, id)) },
            { task_rev: current.rev },
          );
        });
      }
    }
    if (barrier.closed_seq !== null) observed.delete(key);
    if (
      deps &&
      task.owner === slot.agent &&
      task.status === "escalated" &&
      task.escalation?.reason === "replans" &&
      !notified.has(key)
    ) {
      await deps.notify(
        redactor.redact(
          `Task ${task.task_id} exhausted its replan budget after ${task.replan_count} requests; ` +
            `run skep decide. ${barrier.requests
              .map(
                (request) =>
                  `#${request.seq}: ${request.summary} (${request.evidence_count} evidence)`,
              )
              .join("; ")}`,
        ),
      );
      notified.add(key);
    }
    if (barrier.closed_seq !== null) return;
    for (const id of barrier.awaiting) {
      const lease = task.items[id]?.lease;
      if (
        !lease ||
        lease.holder !== slot.agent ||
        lease.interrupt !== barrier.id ||
        isSettled(task, id)
      )
        continue;
      const attemptKey = { task: task.task_id, item: id, epoch: lease.epoch };
      const attemptId = `${key}:${id}:${lease.epoch}`;
      if (!interrupted.has(attemptId)) {
        if (await context.attempt.interrupt(attemptKey, barrier.id)) {
          interrupted.add(attemptId);
          continue;
        }
      }
      if (!deps) continue;
      // A voluntary checkpoint can finish just before the barrier is observed. Rebind only a
      // completed daemon snapshot; absent/unfinished journals wait for reconciliation or timeout.
      const terminal = (await deps.journal(slot).read(attemptKey)).at(-1);
      if (terminal?.step !== "checkpointed") continue;
      const result = terminal.result as { snapshot?: unknown } | undefined;
      const parsed = SnapshotSchema.safeParse(result?.snapshot);
      if (
        !parsed.success ||
        parsed.data.item !== id ||
        parsed.data.epoch !== lease.epoch ||
        parsed.data.attempt_id !== lease.attempt_id ||
        parsed.data.branch !== lease.branch
      )
        throw new ReplanError("Stopped attempt has an invalid checkpoint; repair its journal");
      await publisher.publish((latest) => {
        const current = latest.tasks[task.task_id];
        if (
          current?.barrier?.id !== barrier.id ||
          current.barrier.closed_seq !== null ||
          isSettled(current, id)
        )
          return null;
        return checkpointIntent({
          task_id: task.task_id,
          actor: slot.agent,
          item: id,
          epoch: lease.epoch,
          barrier_id: barrier.id,
          snapshot: parsed.data,
        })(latest);
      });
    }
  };
}

export const replanDuty: ReplanDuty = makeDuty();
export function createReplanDuty(deps: ReplanDutyDependencies): ReplanDuty {
  return makeDuty(deps);
}

/** Structured-output consumers use this before delivery; the reducer cannot verify evidence (§9.5). */
export type ReplanRequestResult =
  | PublishResult
  | { status: "dropped"; reason: "no_request" | "no_verified_evidence" | "stale" };

export async function publishReplanRequest(
  input: {
    task: TaskState;
    actor: string;
    item: string | null;
    report: unknown;
    evidenceKey: AttemptKey;
    eventId?: string;
  },
  deps: {
    verifier: Pick<EvidenceVerifier, "verifyAll">;
    publisher: Pick<Publisher, "publish">;
  },
): Promise<ReplanRequestResult> {
  const report = WorkReportSchema.parse(input.report);
  const request = report.replan_request;
  if (!request) return { status: "dropped", reason: "no_request" };
  const { task, actor, item } = input;
  const lease = item === null ? null : task.items[item]?.lease;
  const plan = task.plans[String(task.active_plan_version)];
  // The payload item may be null for an owner. Evidence still belongs to the invocation's
  // journal, never a guessed first item or the task's latest epoch (ARCHITECTURE §9.5).
  if (
    input.evidenceKey.task !== task.task_id ||
    (item !== null && (input.evidenceKey.item !== item || input.evidenceKey.epoch !== lease?.epoch))
  )
    return { status: "dropped", reason: "stale" };
  if (
    !plan ||
    !["executing", "interrupting", "replanning"].includes(task.status) ||
    (item !== null && !task.items[item]) ||
    (actor !== task.owner && lease?.holder !== actor)
  )
    return { status: "dropped", reason: "stale" };
  const evidence = await deps.verifier.verifyAll(request.evidence, input.evidenceKey);
  // Redacting proof would change the fact being asserted. Unsafe evidence is dropped instead.
  const safe = evidence.filter((entry) => findSecrets(JSON.stringify(entry)).length === 0);
  if (safe.length === 0) return { status: "dropped", reason: "no_verified_evidence" };
  const payload = EVENT_SCHEMAS["replan.requested"].shape.payload.parse({
    item,
    summary: new Redactor().redact(request.summary),
    evidence: safe,
  });
  return deps.publisher.publish(
    (latest) => {
      const current = latest.tasks[task.task_id];
      const active = current?.plans[String(current.active_plan_version)];
      const held = item === null ? null : current?.items[item]?.lease;
      if (
        !current ||
        !["executing", "interrupting", "replanning"].includes(current.status) ||
        active?.plan_hash !== plan.plan_hash ||
        (item !== null &&
          (held?.holder !== actor ||
            held.epoch !== lease?.epoch ||
            held.attempt_id !== lease?.attempt_id)) ||
        (actor === task.owner && (current.owner !== actor || current.owner_gen !== task.owner_gen))
      )
        return null;
      return draft("replan.requested", task.task_id, actor, payload, { task_rev: current.rev });
    },
    input.eventId ? { eventId: input.eventId } : undefined,
  );
}
