import { dirname } from "node:path";
import { deviceOfAgent } from "../core/ids.js";
import type { State, TaskState } from "../core/reducer/state.js";
import type { ChecksFile } from "../core/schemas/config.js";
import { type Plan, PlanSchema } from "../core/schemas/plan.js";

export class PlanValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanValidationError";
  }
}

export interface PlanValidationContext {
  state: State;
  task: TaskState;
  /** Both readers must use the supplied base SHA, never the model's working directory. */
  loadChecks(repo: string, commit: string): Promise<ChecksFile>;
  pathExists(repo: string, commit: string, path: string): Promise<boolean>;
}

export interface ValidatedPlan {
  plan: Plan;
  reviewers: string[];
  warnings: string[];
}

/** Owner-side validation: reducer validation alone cannot verify pinned checks or paths (§11.2). */
export async function validatePlan(
  input: unknown,
  context: PlanValidationContext,
): Promise<ValidatedPlan> {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success)
    throw new PlanValidationError(`Invalid plan: ${parsed.error.message}`, { cause: parsed.error });
  const plan = parsed.data;
  const { state, task } = context;
  if (
    plan.task_id !== task.task_id ||
    plan.version !== (task.current_plan_version ?? 0) + 1 ||
    plan.parent_version !== task.current_plan_version ||
    plan.base.repo !== task.repo ||
    plan.base.branch !== task.base_branch
  ) {
    throw new PlanValidationError(
      "Plan must match the task, next version, parent and repository base branch",
    );
  }
  // D13: mode can upgrade only; a cross-device or multi-item proposal always needs peer review.
  if (task.mode === "team" && plan.mode !== "team")
    throw new PlanValidationError("A team task cannot downgrade to a solo plan");
  if (
    plan.items.length > 1 ||
    plan.items.some((item) => deviceOfAgent(item.assignee) !== deviceOfAgent(task.owner))
  )
    plan.mode = "team";
  if (plan.mode === "solo" && plan.items.length !== 1)
    throw new PlanValidationError("A solo plan must contain exactly one item");
  for (const item of plan.items) {
    const agent = state.agents[item.assignee];
    if (!agent)
      throw new PlanValidationError(`Item ${item.id}: assignee ${item.assignee} is not registered`);
    if (agent.profile.role !== item.role)
      throw new PlanValidationError(`Item ${item.id}: assignee role does not match ${item.role}`);
    const available = new Set([...agent.profile.capabilities, ...agent.profile.requires_local]);
    for (const requirement of item.requires ?? []) {
      if (!available.has(requirement))
        throw new PlanValidationError(
          `Item ${item.id}: ${item.assignee} lacks capability or local requirement ${requirement}`,
        );
    }
    // A capability marked requires_local is tied to this agent's device, not transferable.
    const local = Object.values(state.agents).some((record) =>
      record.profile.requires_local.some((r) => (item.requires ?? []).includes(r)),
    );
    if (
      local &&
      (item.requires ?? []).some(
        (r) =>
          Object.values(state.agents).some((record) => record.profile.requires_local.includes(r)) &&
          !agent.profile.requires_local.includes(r),
      )
    ) {
      throw new PlanValidationError(
        `Item ${item.id}: local requirements are unavailable on ${agent.device}`,
      );
    }
  }
  const checks = await context.loadChecks(plan.base.repo, plan.base.commit);
  const warnings: string[] = [];
  for (const item of plan.items) {
    for (const criterion of item.acceptance) {
      if (criterion.kind === "check" && !Object.hasOwn(checks.checks, criterion.name))
        throw new PlanValidationError(
          `Item ${item.id}: unknown trusted check ${criterion.name} at base commit`,
        );
    }
    for (const path of item.touches) {
      if (
        !(await context.pathExists(plan.base.repo, plan.base.commit, path)) &&
        !(await context.pathExists(plan.base.repo, plan.base.commit, dirname(path)))
      )
        warnings.push(
          `Item ${item.id}: touches path ${path} has no existing parent at base commit`,
        );
    }
  }
  const peers = [...new Set(plan.items.map((item) => item.assignee))]
    .filter((agent) => agent !== task.owner)
    .sort();
  if (plan.mode === "team" && peers.length === 0)
    throw new PlanValidationError(
      "A team plan requires a registered non-owner assignee for peer review",
    );
  return { plan, reviewers: plan.mode === "team" ? peers.slice(0, 1) : [], warnings };
}
