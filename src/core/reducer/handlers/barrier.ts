import type { ItemId } from "../../ids.js";
import type { TaskState } from "../state.js";

export function isSettled(task: TaskState, item: ItemId): boolean {
  return (task.barrier?.checkpointed.includes(item) ?? false) || task.items[item]?.lease === null;
}

export function settleBarrier(task: TaskState, seq: number): void {
  const barrier = task.barrier;
  if (
    !barrier ||
    barrier.closed_seq !== null ||
    !barrier.awaiting.every((id) => isSettled(task, id))
  )
    return;
  // ARCHITECTURE §5.5: exhausted replans still wait for holders to settle before escalating.
  barrier.closed_seq = seq;
  task.status = barrier.escalate ? "escalated" : "replanning";
  if (barrier.escalate) task.escalation = { reason: "replans", seq };
}
