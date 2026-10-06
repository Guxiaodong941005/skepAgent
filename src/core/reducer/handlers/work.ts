import type { Handler } from "./types.js";

export const handleWorkDelivered: Handler<"work.delivered"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleWorkFailed: Handler<"work.failed"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});
