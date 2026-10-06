import type { AgentId } from "../../ids.js";
import { workBranch } from "../../ids.js";
import type { ItemState, State } from "../state.js";
import { settleBarrier } from "./barrier.js";
import type { Handler } from "./types.js";

/**
 * D16 (ARCHITECTURE §6.1): only a lease whose item is still `leased` counts toward
 * `max_parallel_items`. A lease parked by a barrier (item `interrupted` after its checkpoint) keeps
 * its record for audit until the next plan activation but no longer occupies a slot. A flagged
 * lease that has not checkpointed yet still counts: its process may still be running.
 */
export function countsTowardMaxParallel(item: ItemState, agent: AgentId): boolean {
  return item.status === "leased" && item.lease?.holder === agent;
}

/** Active leases of `agent` across all tasks (D16); shared with views (SK-204). */
export function activeLeaseCount(state: State, agent: AgentId): number {
  let count = 0;
  for (const task of Object.values(state.tasks))
    for (const item of Object.values(task.items))
      if (countsTowardMaxParallel(item, agent)) count += 1;
  return count;
}

export const handleLeaseClaimed: Handler<"lease.claimed"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "executing") return { ok: false, reason: "bad_task_state" };
  if (task.barrier !== null) return { ok: false, reason: "barrier_open" };
  const payload = event.payload;
  const item = task.items[payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  if (item.status !== "ready") return { ok: false, reason: "item_not_ready" };
  if (item.assignee !== event.actor) return { ok: false, reason: "not_assignee" };
  const epoch = task.epochs[payload.item] ?? 0;
  if (event.pre.expected_epoch !== epoch) return { ok: false, reason: "epoch_mismatch" };
  const plan = task.plans[String(task.active_plan_version)];
  if (!plan || event.pre.plan_hash !== plan.plan_hash) return { ok: false, reason: "plan_changed" };
  const agent = draft.agents[event.actor];
  if (!agent) return { ok: false, reason: "unknown_agent" };
  if (activeLeaseCount(draft, event.actor) >= agent.profile.max_parallel_items)
    return { ok: false, reason: "max_parallel" };
  if (item.attempts_this_plan > task.budgets.item_retries)
    return { ok: false, reason: "retry_budget" };
  if (payload.branch !== workBranch(task.task_id, payload.item, epoch + 1))
    return { ok: false, reason: "bad_branch" };

  task.epochs[payload.item] = epoch + 1;
  item.lease = {
    epoch: epoch + 1,
    holder: event.actor,
    attempt_id: payload.attempt_id,
    branch: payload.branch,
    plan_version: plan.version,
    plan_hash: plan.plan_hash,
    granted_at_seq: ctx.seq,
    interrupt: null,
  };
  item.status = "leased";
  item.attempts_this_plan += 1;
  return { ok: true };
};

export const handleLeaseReleased: Handler<"lease.released"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "interrupting"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const item = task.items[event.payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  const lease = item.lease;
  if (!lease || lease.holder !== event.actor || lease.epoch !== event.payload.epoch)
    return { ok: false, reason: "fenced" };
  item.lease = null;
  item.status = "ready";
  settleBarrier(task, ctx.seq);
  return { ok: true };
};

export const handleLeaseRevoked: Handler<"lease.revoked"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["executing", "interrupting", "escalated"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const item = task.items[event.payload.item];
  if (!item) return { ok: false, reason: "unknown_item" };
  if (!item.lease || item.lease.epoch !== event.payload.epoch)
    return { ok: false, reason: "epoch_mismatch" };
  item.lease = null;
  item.status = task.status === "interrupting" ? "unknown" : "ready";
  settleBarrier(task, ctx.seq);
  return { ok: true };
};
