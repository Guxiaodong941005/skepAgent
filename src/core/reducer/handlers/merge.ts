import type { Handler } from "./types.js";

export const handleItemMerged: Handler<"item.merged"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "delivered", "escalated"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  if (
    item.status !== "delivered" ||
    !item.delivered ||
    payload.pr_number !== item.delivered.pr_number
  )
    return { ok: false, reason: "bad_task_state" };
  item.merged = { pr_number: payload.pr_number, merge_sha: payload.merge_sha, seq: ctx.seq };
  item.status = "merged";
  if (Object.values(task.items).every((i) => i.status === "merged")) task.status = "done";
  return { ok: true };
};

export const handleTaskVerified: Handler<"task.verified"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "delivered") return { ok: false, reason: "bad_task_state" };
  const top = task.plans[String(task.active_plan_version)]?.plan.stack_order.at(-1);
  if (!top || task.items[top]?.delivered?.head_sha !== event.payload.top_of_stack_sha)
    return { ok: false, reason: "bad_task_state" };
  task.verified = {
    top_of_stack_sha: event.payload.top_of_stack_sha,
    passed: event.payload.passed,
    seq: ctx.seq,
  };
  // D14 (ARCHITECTURE §5.5): the top item has no lease once the task is delivered, so a failed
  // combined check cannot be a fenced work.failed (PRD §9.8); it escalates to the human instead.
  if (!event.payload.passed) {
    task.status = "escalated";
    task.escalation = { reason: "verification_failed", seq: ctx.seq };
  }
  return { ok: true };
};
