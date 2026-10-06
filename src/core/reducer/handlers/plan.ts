import { canonicalJson, contentHash } from "../../canonical.js";
import type { PlanItem } from "../../schemas/plan.js";
import type { ItemState, TaskState } from "../state.js";
import type { Handler } from "./types.js";

function carryDefinition(item: PlanItem): string {
  // ARCHITECTURE §5.5/D7 defines which fields allow completed work to survive replanning.
  return canonicalJson({
    title: item.title,
    assignee: item.assignee,
    depends_on: item.depends_on,
    touches: item.touches,
    acceptance: item.acceptance,
    requires: item.requires ?? [],
  });
}

export function activatePlan(task: TaskState, version: number, seq: number): void {
  // Callers select an existing plan and PlanSchema validates stack_order (ARCHITECTURE §4.5).
  // These guards catch internal inconsistencies unreachable from a validated log.
  const record = task.plans[String(version)];
  if (!record)
    throw new RangeError(`Cannot activate missing plan version ${version} for ${task.task_id}`);
  const previous = task.plans[String(task.active_plan_version)]?.plan;
  const items: Record<string, ItemState> = {};
  for (const id of record.plan.stack_order) {
    const definition = record.plan.items.find((item) => item.id === id);
    if (!definition) throw new RangeError(`Plan version ${version} has no definition for ${id}`);
    const old = task.items[id];
    const oldDefinition = previous?.items.find((item) => item.id === id);
    const carry =
      old !== undefined &&
      oldDefinition !== undefined &&
      (old.status === "delivered" || old.status === "merged") &&
      carryDefinition(oldDefinition) === carryDefinition(definition);
    items[id] = {
      id,
      title: definition.title,
      assignee: definition.assignee,
      depends_on: [...definition.depends_on],
      requires: [...(definition.requires ?? [])],
      status: carry
        ? old.status
        : definition.depends_on.every(
              (dep) => items[dep]?.status === "delivered" || items[dep]?.status === "merged",
            )
          ? "ready"
          : "blocked",
      lease: null,
      delivered: carry ? structuredClone(old.delivered) : null,
      merged: carry ? structuredClone(old.merged) : null,
      failure: null,
      last_checkpoint: null,
      attempts_this_plan: 0,
    };
  }
  task.items = items;
  task.active_plan_version = version;
  // D15 (ARCHITECTURE §5.5): a plan whose items all carried over as delivered/merged (D7) has no
  // work left to claim, so no work.delivered would ever move the task on from `executing`.
  const statuses = Object.values(items).map((item) => item.status);
  task.status = statuses.every((status) => status === "merged")
    ? "done"
    : statuses.every((status) => status === "delivered" || status === "merged")
      ? "delivered"
      : "executing";
  task.last_seq = seq;
  task.barrier = null;
  task.escalation = null;
  task.verified = null;
}

function enforceReviewBudget(task: TaskState, seq: number): void {
  if (task.review_rounds > task.budgets.review_rounds) {
    task.status = "escalated";
    task.escalation = { reason: "review_rounds", seq };
  }
}

export const handlePlanProposed: Handler<"plan.proposed"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (!["planning", "replanning", "reviewing"].includes(task.status))
    return { ok: false, reason: "bad_task_state" };
  const payload = event.payload;
  const plan = payload.plan;
  if (contentHash(plan) !== payload.plan_hash) return { ok: false, reason: "plan_hash_mismatch" };
  if (
    payload.version !== (task.current_plan_version ?? 0) + 1 ||
    payload.parent_version !== task.current_plan_version ||
    plan.task_id !== task.task_id ||
    plan.version !== payload.version ||
    plan.parent_version !== payload.parent_version ||
    payload.base_commit !== plan.base.commit ||
    plan.base.repo !== task.repo ||
    plan.mode !== task.mode ||
    plan.items.some((item) => !draft.agents[item.assignee]) ||
    new Set(payload.reviewers).size !== payload.reviewers.length ||
    (task.mode === "solo"
      ? payload.reviewers.length !== 0
      : payload.reviewers.length < 1 ||
        payload.reviewers.length > 4 ||
        payload.reviewers.some((reviewer) => reviewer === task.owner || !draft.agents[reviewer]))
  ) {
    return { ok: false, reason: "invalid_plan" };
  }
  const previous = task.plans[String(task.current_plan_version)];
  if (
    previous &&
    previous.decision?.kind !== "rejected" &&
    Object.values(previous.reviews).some((review) => review.verdict === "block")
  )
    task.review_rounds += 1;
  task.plans[String(payload.version)] = {
    version: payload.version,
    plan_hash: payload.plan_hash,
    plan: structuredClone(plan),
    base_commit: payload.base_commit,
    reviewers: [...payload.reviewers],
    proposed_seq: ctx.seq,
    owner_gen: task.owner_gen,
    reviews: {},
    locked: task.mode === "solo" ? { seq: ctx.seq, overrides: [], missing_reviews: [] } : null,
    decision: null,
  };
  task.current_plan_version = payload.version;
  task.status = task.mode === "team" ? "reviewing" : "awaiting_approval";
  enforceReviewBudget(task, ctx.seq);
  return { ok: true };
};

export const handleReviewSubmitted: Handler<"review.submitted"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "reviewing") return { ok: false, reason: "bad_task_state" };
  const record = task.plans[String(task.current_plan_version)];
  if (!record) return { ok: false, reason: "unknown_plan_version" };
  if (event.payload.plan_version !== record.version || event.payload.plan_hash !== record.plan_hash)
    return { ok: false, reason: "plan_changed" };
  record.reviews[event.actor] = {
    reviewer: event.actor,
    seq: ctx.seq,
    verdict: event.payload.verdict,
    payload: structuredClone(event.payload),
  };
  return { ok: true };
};

export const handlePlanLocked: Handler<"plan.locked"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (
    !(task.mode === "team" && task.status === "reviewing") &&
    !(task.mode === "solo" && task.status === "awaiting_approval" && task.plan_approval === "owner")
  )
    return { ok: false, reason: "bad_task_state" };
  const record = task.plans[String(task.current_plan_version)];
  if (!record) return { ok: false, reason: "unknown_plan_version" };
  const payload = event.payload;
  if (payload.plan_version !== record.version || payload.plan_hash !== record.plan_hash)
    return { ok: false, reason: "plan_changed" };
  const missing = record.reviewers.filter((reviewer) => !record.reviews[reviewer]).sort();
  if (
    canonicalJson([...payload.missing_reviews].sort()) !== canonicalJson(missing) ||
    payload.overrides.some((override) => {
      const review = record.reviews[override.reviewer];
      return (
        review?.verdict !== "block" ||
        !review.payload.blockers.some((blocker) => blocker.id === override.blocker_id)
      );
    })
  )
    return { ok: false, reason: "invalid_plan" };
  record.locked = {
    seq: ctx.seq,
    overrides: structuredClone(payload.overrides),
    missing_reviews: [...payload.missing_reviews],
  };
  if (task.plan_approval === "owner" && !record.plan.items.some((item) => item.risk === "high"))
    activatePlan(task, record.version, ctx.seq);
  else task.status = "awaiting_approval";
  return { ok: true };
};

export const handlePlanApproved: Handler<"plan.approved"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "awaiting_approval") return { ok: false, reason: "bad_task_state" };
  const record = task.plans[String(task.current_plan_version)];
  if (!record) return { ok: false, reason: "unknown_plan_version" };
  if (event.payload.plan_version !== record.version || event.payload.plan_hash !== record.plan_hash)
    return { ok: false, reason: "plan_changed" };
  if (record.locked === null) return { ok: false, reason: "bad_task_state" };
  record.decision = { kind: "approved", seq: ctx.seq, note: event.payload.note ?? null };
  activatePlan(task, record.version, ctx.seq);
  return { ok: true };
};

export const handlePlanRejected: Handler<"plan.rejected"> = (draft, event, ctx) => {
  const task = draft.tasks[event.task_id];
  if (!task) return { ok: false, reason: "unknown_task" };
  if (task.status !== "awaiting_approval") return { ok: false, reason: "bad_task_state" };
  const record = task.plans[String(task.current_plan_version)];
  if (!record) return { ok: false, reason: "unknown_plan_version" };
  if (event.payload.plan_version !== record.version || event.payload.plan_hash !== record.plan_hash)
    return { ok: false, reason: "plan_changed" };
  record.decision = { kind: "rejected", seq: ctx.seq, note: event.payload.note ?? null };
  task.review_rounds += 1;
  task.status = "planning";
  enforceReviewBudget(task, ctx.seq);
  return { ok: true };
};
