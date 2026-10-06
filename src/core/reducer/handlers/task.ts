import { deviceOfAgent } from "../../ids.js";
import { activatePlan } from "./plan.js";
import type { Handler } from "./types.js";

export const handleAgentRegistered: Handler<"agent.registered"> = (draft, event, ctx) => {
  const device = deviceOfAgent(event.actor);
  if (device === null) return { ok: false, reason: "unauthorized" };
  draft.agents[event.actor] = {
    agent: event.actor,
    device,
    profile: structuredClone(event.payload),
    registered_seq: ctx.seq,
  };
  return { ok: true };
};

export const handleTaskCreated: Handler<"task.created"> = (draft, event, ctx) => {
  const payload = event.payload;
  if (!draft.agents[payload.owner]) return { ok: false, reason: "unknown_agent" };
  draft.tasks[event.task_id] = {
    task_id: event.task_id,
    status: "planning",
    created_seq: ctx.seq,
    rev: 0,
    last_seq: ctx.seq,
    title: payload.title,
    body: payload.body,
    repo: payload.repo,
    base_branch: payload.base_branch,
    mode: payload.mode,
    plan_approval: payload.plan_approval,
    budgets: structuredClone(payload.budgets),
    owner: payload.owner,
    owner_gen: 1,
    plans: {},
    current_plan_version: null,
    active_plan_version: null,
    review_rounds: 0,
    replan_count: 0,
    barrier: null,
    epochs: {},
    items: {},
    escalation: null,
    verified: null,
    cancelled: null,
  };
  return { ok: true };
};

export const handleTaskCancelled: Handler<"task.cancelled"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  task.status = "cancelled";
  task.cancelled = { reason: event.payload.reason, seq: ctx.seq };
  task.barrier = null;
  for (const item of Object.values(task.items)) item.lease = null;
  return { ok: true };
};

export const handleOwnerTransferred: Handler<"owner.transferred"> = (draft, event) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!draft.agents[event.payload.new_owner]) return { ok: false, reason: "unknown_agent" };
  task.owner = event.payload.new_owner;
  task.owner_gen += 1;
  return { ok: true };
};

export const handleHumanDecided: Handler<"human.decided"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "escalated") return { ok: false, reason: "bad_task_state" };
  switch (event.payload.decision) {
    case "resume_with_plan": {
      const version = task.active_plan_version;
      if (version === null || !task.plans[String(version)]) {
        return { ok: false, reason: "bad_decision", detail: "there is no active plan to resume" };
      }
      activatePlan(task, version, ctx.seq);
      break;
    }
    case "replan":
      task.status = "planning";
      break;
    case "cancel":
      task.status = "cancelled";
      task.cancelled = {
        reason: event.payload.note ?? "Cancelled by human decision",
        seq: ctx.seq,
      };
      task.barrier = null;
      for (const item of Object.values(task.items)) item.lease = null;
      break;
    case "reassign_owner": {
      const owner = event.payload.new_owner;
      if (owner === undefined) return { ok: false, reason: "bad_decision" };
      if (!draft.agents[owner]) return { ok: false, reason: "unknown_agent" };
      task.owner = owner;
      task.owner_gen += 1;
      task.status = "planning";
      break;
    }
  }
  task.escalation = null;
  return { ok: true };
};
