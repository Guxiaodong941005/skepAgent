import type { Handler } from "./types.js";

export const handleItemMerged: Handler<"item.merged"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleTaskVerified: Handler<"task.verified"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});
