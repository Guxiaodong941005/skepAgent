import type { SkepEvent } from "../schemas/events.js";
import { type ApplyResult, type State, TERMINAL_TASK_STATUSES } from "./state.js";

export function checkPre(event: SkepEvent, state: State): ApplyResult {
  const task = event.task_id === null ? undefined : state.tasks[event.task_id];
  if (event.type === "task.created") {
    if (task) return { ok: false, reason: "task_exists" };
  } else if (event.type !== "agent.registered") {
    if (!task) return { ok: false, reason: "unknown_task" };
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return { ok: false, reason: "task_terminal" };
  }
  const pre = event.pre;
  if (!task) {
    return Object.keys(pre).length === 0
      ? { ok: true }
      : { ok: false, reason: "pre_mismatch", detail: "preconditions require an existing task" };
  }
  if (
    (pre.task_rev !== undefined && pre.task_rev !== task.rev) ||
    (pre.owner_gen !== undefined && pre.owner_gen !== task.owner_gen)
  ) {
    return { ok: false, reason: "pre_mismatch" };
  }
  if (
    (pre.plan_version !== undefined && pre.plan_version !== task.current_plan_version) ||
    (pre.plan_hash !== undefined &&
      pre.plan_hash !== task.plans[String(task.current_plan_version)]?.plan_hash)
  ) {
    return { ok: false, reason: "plan_changed" };
  }
  if (pre.item !== undefined && !task.items[pre.item]) return { ok: false, reason: "unknown_item" };
  if (pre.expected_epoch !== undefined) {
    if (pre.item === undefined)
      return { ok: false, reason: "unknown_item", detail: "expected_epoch requires pre.item" };
    if (pre.expected_epoch !== (task.epochs[pre.item] ?? 0))
      return { ok: false, reason: "epoch_mismatch" };
  }
  return { ok: true };
}
