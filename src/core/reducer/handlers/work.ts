import { settleBarrier } from "./barrier.js";
import type { Handler } from "./types.js";

export const handleWorkDelivered: Handler<"work.delivered"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "executing") return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  const lease = item.lease;
  if (!lease || lease.holder !== event.actor || lease.epoch !== payload.epoch)
    return { ok: false, reason: "fenced" };
  if (lease.interrupt !== null) return { ok: false, reason: "interrupted" };
  if (payload.branch !== lease.branch) return { ok: false, reason: "bad_branch" };

  item.delivered = {
    epoch: payload.epoch,
    branch: payload.branch,
    head_sha: payload.head_sha,
    submit: structuredClone(payload.submit),
    check_runs: structuredClone(payload.check_runs),
    seq: ctx.seq,
  };
  item.lease = null;
  item.status = "delivered";
  // ARCHITECTURE §5.5 permits merges while executing; merged dependencies remain delivered.
  const completed = (id: string): boolean =>
    task.items[id]?.status === "delivered" || task.items[id]?.status === "merged";
  for (const dependent of Object.values(task.items)) {
    if (dependent.status === "blocked" && dependent.depends_on.every(completed))
      dependent.status = "ready";
  }
  if (Object.keys(task.items).every(completed)) task.status = "delivered";
  return { ok: true };
};

export const handleWorkSubmitted: Handler<"work.submitted"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "delivered", "escalated"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  if (item.status !== "delivered" || item.delivered?.submit.state !== "pending" || item.submission)
    return { ok: false, reason: "bad_task_state" };
  if (item.delivered.epoch !== payload.epoch) return { ok: false, reason: "epoch_mismatch" };
  if (item.delivered.head_sha !== payload.head_sha) return { ok: false, reason: "bad_task_state" };
  // Delivery already cleared the lease; the recorded SHA fences this later human decision.
  item.submission = { ...structuredClone(payload), seq: ctx.seq };
  return { ok: true };
};

export const handleWorkFailed: Handler<"work.failed"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "interrupting"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  const lease = item.lease;
  if (!lease || lease.holder !== event.actor || lease.epoch !== payload.epoch)
    return { ok: false, reason: "fenced" };
  item.failure = {
    epoch: payload.epoch,
    class: payload.class,
    detail: payload.detail,
    seq: ctx.seq,
  };
  item.status = "failed";
  item.lease = null;
  if (task.status === "interrupting") {
    settleBarrier(task, ctx.seq);
  } else if (
    item.attempts_this_plan <= task.budgets.item_retries &&
    payload.class !== "budget_exceeded"
  ) {
    item.status = "ready";
  } else {
    task.status = "escalated";
    task.escalation = {
      reason: payload.class === "budget_exceeded" ? "budget_exceeded" : "item_failed",
      seq: ctx.seq,
    };
  }
  return { ok: true };
};
