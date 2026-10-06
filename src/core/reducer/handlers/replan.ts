import { canonicalJson } from "../../canonical.js";
import { isSettled, settleBarrier } from "./barrier.js";
import type { Handler } from "./types.js";

export const handleReplanRequested: Handler<"replan.requested"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "interrupting", "replanning"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  if (ctx.principal.kind !== "human" && payload.evidence.length === 0)
    return { ok: false, reason: "missing_evidence" };
  const request = {
    seq: ctx.seq,
    event_id: event.event_id,
    actor: event.actor,
    summary: payload.summary,
    evidence_count: payload.evidence.length,
  };
  // D6 (ARCHITECTURE §5.5): keep the settled barrier for late requests until activation.
  if (task.status !== "executing") {
    if (!task.barrier) return { ok: false, reason: "no_barrier" };
    task.barrier.requests.push(request);
    return { ok: true };
  }
  if (payload.item !== null && !task.items[payload.item])
    return { ok: false, reason: "unknown_item" };
  const plan = task.plans[String(task.active_plan_version)];
  if (!plan) return { ok: false, reason: "unknown_plan_version" };
  const awaiting = plan.plan.stack_order.filter((id) => task.items[id]?.status === "leased");
  task.replan_count += 1;
  task.barrier = {
    id: `B${ctx.seq}`,
    opened_seq: ctx.seq,
    closed_seq: null,
    requests: [request],
    awaiting,
    checkpointed: [],
    escalate: task.replan_count > task.budgets.replans,
  };
  for (const id of awaiting) {
    const lease = task.items[id]?.lease;
    if (lease) lease.interrupt = task.barrier.id;
  }
  task.status = "interrupting";
  settleBarrier(task, ctx.seq);
  return { ok: true };
};

export const handleCheckpointRecorded: Handler<"checkpoint.recorded"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "interrupting", "replanning", "escalated"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  const lease = item.lease;
  if (!lease || lease.holder !== event.actor || lease.epoch !== payload.epoch)
    return { ok: false, reason: "fenced" };
  const snapshot = payload.snapshot;
  if (snapshot.item !== payload.item || snapshot.epoch !== payload.epoch)
    return { ok: false, reason: "bad_snapshot" };
  if (payload.barrier_id !== null && payload.barrier_id !== task.barrier?.id)
    return { ok: false, reason: "no_barrier" };

  item.last_checkpoint = {
    epoch: payload.epoch,
    seq: ctx.seq,
    barrier_id: payload.barrier_id,
    head_sha: snapshot.head_sha,
    invocation_state: snapshot.invocation_state,
  };
  if (payload.barrier_id !== null && task.barrier) {
    // D16 (ARCHITECTURE §6.1): a stopped holder keeps its fenced lease for audit, freeing a slot.
    item.status = "interrupted";
    if (!task.barrier.checkpointed.includes(payload.item))
      task.barrier.checkpointed.push(payload.item);
    settleBarrier(task, ctx.seq);
  }
  return { ok: true };
};

export const handleBarrierClosed: Handler<"barrier.closed"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "interrupting") return { ok: false, reason: "bad_task_state" };
  const barrier = task.barrier;
  if (!barrier || event.payload.barrier_id !== barrier.id || barrier.closed_seq !== null)
    return { ok: false, reason: "no_barrier" };
  const missing = barrier.awaiting.filter((id) => !isSettled(task, id));
  if (canonicalJson([...event.payload.missing].sort()) !== canonicalJson([...missing].sort()))
    return { ok: false, reason: "pre_mismatch" };

  for (const id of missing) {
    const item = task.items[id];
    if (item) {
      item.lease = null;
      item.status = "unknown";
    }
  }
  settleBarrier(task, ctx.seq);
  return { ok: true };
};
