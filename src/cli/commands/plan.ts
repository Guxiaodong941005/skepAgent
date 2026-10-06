import { type Command, InvalidArgumentError } from "commander";
import { SHA256_TAGGED_RE } from "../../core/ids.js";
import type { CliContext } from "../context.js";
import { loadPlanView, type PlanView, publishHuman } from "../publish.js";
import { reportPublished } from "../publish-output.js";
import { parsePositiveInt, parseTaskId } from "../validate.js";

/**
 * `skep plan show|approve|reject` (PRD §15.2).
 *
 * `approve` and `reject` decide the plan currently awaiting approval. `--hash` pins that to the
 * plan the human read: a plan that moved on since is dropped rather than decided. `show`
 * publishes nothing: it reads the replayed state and prints the plan, its reviews and the lock
 * overrides.
 */
export function register(program: Command, ctx: CliContext): void {
  const plan = program.command("plan").description("Inspect or approve a plan");

  plan
    .command("show")
    .description("Show a task's plan, reviews, and overrides")
    .argument("<task>", "task id", parseTaskId)
    .option("--version <n>", "plan version (default: current)", parsePositiveInt)
    .option("--diff", "include the diff against the previous version")
    .action(async (taskId: string, opts: { version?: number; diff?: boolean }) => {
      const view = await loadPlanView(ctx, taskId, opts.version);
      const output = ctx.output();
      output.result(view, () => renderPlan(view, opts.diff === true));
    });

  plan
    .command("approve")
    .description("Approve the plan awaiting approval")
    .argument("<task>", "task id", parseTaskId)
    .option("--note <text>", "note recorded with the decision")
    .option("--hash <sha256:...>", "approve only this plan hash", parsePlanHash)
    .action(async (taskId: string, opts: { note?: string; hash?: string }) => {
      reportPublished(ctx, await publishHuman(ctx, decisionSpec("plan.approve", taskId, opts)));
    });

  plan
    .command("reject")
    .description("Reject the plan awaiting approval")
    .argument("<task>", "task id", parseTaskId)
    .option("--note <text>", "note recorded with the decision")
    .option("--hash <sha256:...>", "reject only this plan hash", parsePlanHash)
    .action(async (taskId: string, opts: { note?: string; hash?: string }) => {
      reportPublished(ctx, await publishHuman(ctx, decisionSpec("plan.reject", taskId, opts)));
    });
}

/** `--hash` is the `sha256:` plan hash the human read; anything else is a usage error. */
function parsePlanHash(value: string): string {
  if (!SHA256_TAGGED_RE.test(value)) {
    throw new InvalidArgumentError(`invalid plan hash '${value}' (expected sha256:<64 hex>)`);
  }
  return value;
}

function decisionSpec(
  kind: "plan.approve" | "plan.reject",
  taskId: string,
  opts: { note?: string; hash?: string },
): { kind: "plan.approve" | "plan.reject"; task: string; note?: string; plan_hash?: string } {
  return {
    kind,
    task: taskId,
    ...(opts.note === undefined ? {} : { note: opts.note }),
    ...(opts.hash === undefined ? {} : { plan_hash: opts.hash }),
  };
}

/** Human rendering of one plan version. `--diff` adds the recorded change from its parent. */
function renderPlan(view: PlanView, diff: boolean): string {
  const lines = [
    `${view.task_id} plan v${view.version} (${view.plan_hash})`,
    `status: ${view.status}`,
    `base: ${view.base.repo} ${view.base.branch} ${view.base.commit}`,
    `summary: ${view.summary}`,
    ...view.items.map(
      (item) =>
        `${item.id} ${item.status} ${item.title} -> ${item.assignee}` +
        (item.depends_on.length > 0 ? ` (after ${item.depends_on.join(", ")})` : ""),
    ),
  ];
  if (view.locked) {
    lines.push(
      `locked at #${view.locked.seq}` +
        (view.locked.overrides.length > 0 ? `, ${view.locked.overrides.length} override(s)` : ""),
    );
    for (const override of view.locked.overrides) {
      lines.push(`override ${override.blocker_id} by ${override.reviewer}: ${override.rationale}`);
    }
  }
  if (view.decision) {
    lines.push(`decision: ${view.decision.kind} at #${view.decision.seq}`);
  }
  for (const review of view.reviews) {
    lines.push(`review ${review.reviewer}: ${review.verdict} at #${review.seq}`);
  }
  if (diff) {
    lines.push(`changes from parent: ${view.changes_from_parent ?? "(none)"}`);
  }
  return `${lines.join("\n")}\n`;
}
