import type { Handler } from "./types.js";

export const handleLeaseClaimed: Handler<"lease.claimed"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleLeaseReleased: Handler<"lease.released"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});

export const handleLeaseRevoked: Handler<"lease.revoked"> = () => ({
  ok: false,
  reason: "bad_task_state",
  detail: "not implemented",
});
