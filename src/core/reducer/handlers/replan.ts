import type { Handler } from "./types.js";

export const handleReplanRequested: Handler<"replan.requested"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleCheckpointRecorded: Handler<"checkpoint.recorded"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleBarrierClosed: Handler<"barrier.closed"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});
