import { workBranch } from "../../ids.js";
import { settleBarrier } from "./barrier.js";
import type { Handler } from "./types.js";

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
  const held = Object.values(draft.tasks).reduce(
    (count, other) =>
      count + Object.values(other.items).filter((i) => i.lease?.holder === event.actor).length,
    0,
  );
  if (held >= agent.profile.max_parallel_items) return { ok: false, reason: "max_parallel" };
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
