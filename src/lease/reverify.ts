import type { Sync } from "../blackboard/sync.js";
import type { AgentId } from "../core/ids.js";
import type { State } from "../core/reducer/state.js";
import type { HeldLease } from "../core/reducer/views.js";

/** Views are scoped to an agent; carry that identity explicitly across a fresh observation. */
export interface LeaseIdentity extends Pick<HeldLease, "task_id" | "item" | "epoch"> {
  holder: AgentId;
}

export type LeaseObserver = Pick<Sync, "observeNow">;

export function isCurrentLease(state: State, lease: LeaseIdentity): boolean {
  const task = state.tasks[lease.task_id];
  const current = task?.items[lease.item]?.lease;
  return (
    task?.status === "executing" &&
    current !== null &&
    current !== undefined &&
    current.holder === lease.holder &&
    current.epoch === lease.epoch &&
    current.interrupt === null
  );
}

/** Always fetch through Sync: a polling cache or relay hint cannot authorize delivery (§6.3). */
export async function reverify(sync: LeaseObserver, lease: LeaseIdentity): Promise<"ok" | "stale"> {
  const identity = { ...lease };
  const state = await sync.observeNow();
  return isCurrentLease(state, identity) ? "ok" : "stale";
}
