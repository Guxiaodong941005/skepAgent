import { z } from "zod";
import type { TaskState } from "../core/reducer/state.js";
import type { CheckRun } from "../core/schemas/common.js";
import type { Evidence } from "../core/schemas/evidence.js";
import { type Plan, PlanSchema } from "../core/schemas/plan.js";
import { type Review, ReviewSchema } from "../core/schemas/review.js";
import { type WorkReport, WorkReportSchema } from "../core/schemas/work-report.js";

export interface PromptContext {
  agentInstructions: string;
  /** Context gathered by the daemon at the pinned commit, never read by these builders. */
  repoContext: string;
}

export interface PlanAgentProfile {
  agent: string;
  device: string;
  role: string;
  capabilities: readonly string[];
  requires_local: readonly string[];
}

export interface PlanPromptInput extends PromptContext {
  task: Pick<TaskState, "task_id" | "title" | "body" | "repo" | "base_branch" | "mode" | "budgets">;
  baseCommit: string;
  version: number;
  agents: readonly PlanAgentProfile[];
  /** Names from the trusted checks file at baseCommit. */
  checks: readonly string[];
  parentPlan?: Plan | null;
  reviews?: readonly Review[];
  checkpoints?: readonly unknown[];
  evidence?: readonly Evidence[];
}

export interface ReviewPromptInput extends PromptContext {
  plan: Plan;
  planHash: string;
  evidence?: readonly Evidence[];
}

export interface WorkPromptInput extends PromptContext {
  plan: Plan;
  itemId: string;
  epoch: number;
  /** The predecessor's delivered head for a stacked item, otherwise the plan base. */
  baseCommit: string;
  checkpoint?: unknown;
  evidence?: readonly Evidence[];
}

export interface FixupPromptInput extends WorkPromptInput {
  checkRuns: readonly CheckRun[];
  logTail: string;
  previousReport?: WorkReport | null;
}

export interface RepairPromptInput {
  originalPrompt: string;
  finalMessage: string | null;
  validationErrors: string;
  outputSchema: Record<string, unknown>;
}

function section(label: string, value: unknown): string {
  return `${label}:\n${JSON.stringify(value, null, 2)}`;
}

function context(input: PromptContext): string[] {
  return [
    `Agent instructions:\n${input.agentInstructions}`,
    "Do not read, include, or copy provider credentials or provider configuration (ARCHITECTURE D19).",
    `Repository context at the pinned commit:\n${input.repoContext}`,
  ];
}

function output(schema: z.ZodType): string {
  return [
    "Return exactly one JSON object matching this schema. Use no Markdown fences, prose, or extra keys.",
    section("Output JSON Schema", z.toJSONSchema(schema)),
  ].join("\n\n");
}

/** Inputs include all policy and context: prompts never consult local files or the environment. */
export function buildPlanPrompt(input: PlanPromptInput): string {
  return [
    ...context(input),
    "Draft a skep.plan/v1 plan for the task. Planning is read-only; do not edit repository files.",
    "Use the supplied task id, version, repository, base branch, and base commit. Set parent_version to null for version 1, otherwise to the parent plan's version.",
    "A solo plan has exactly one item. A team plan has at most four items. A solo task may upgrade to a team plan; a team task must keep team mode (ARCHITECTURE D13).",
    "Use a linear stack: stack_order lists every item once; the first item has no dependencies and each later item depends only on its predecessor.",
    "Assign only registered agents whose roles, capabilities, and local requirements match. Include implementation details, intended paths, risk, and acceptance criteria for each item.",
    "Acceptance checks must use the supplied trusted check names; do not invent commands or modify the trusted checks file. Manual criteria are advisory.",
    "For a replan, address reviews, checkpoints, and verified evidence. Keep unchanged delivered item definitions identical so they can carry over (ARCHITECTURE D7). Explain changes_from_parent.",
    section("Task", input.task),
    section("Plan version and pinned base commit", {
      version: input.version,
      commit: input.baseCommit,
    }),
    section("Registered agent profiles", input.agents),
    section("Trusted check names", input.checks),
    section("Parent plan", input.parentPlan ?? null),
    section("Reviews", input.reviews ?? []),
    section("Mechanical checkpoints", input.checkpoints ?? []),
    section("Available evidence", input.evidence ?? []),
    output(PlanSchema),
  ].join("\n\n");
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return [
    ...context(input),
    "Review the supplied plan without editing repository files. Return skep.review/v1 with the exact supplied plan version and hash.",
    // PRD §9.3 explicitly accepts approval and discourages manufacturing objections.
    "Approve when no blocker is found. Do not object for its own sake. Suggestions are advisory and never block.",
    "A block verdict requires at least one concrete blocker with evidence of an acceptance gap. Use typed evidence pinned to a commit or an existing daemon journal run; never invent hashes, excerpts, or run ids.",
    "The daemon verifies evidence and downgrades a block with no verified evidence to comment (ARCHITECTURE §9.5).",
    section("Plan", input.plan),
    section("Exact review binding", {
      plan_version: input.plan.version,
      plan_hash: input.planHash,
    }),
    section("Available evidence", input.evidence ?? []),
    output(ReviewSchema),
  ].join("\n\n");
}

function workContext(input: WorkPromptInput): string[] {
  return [
    ...context(input),
    section("Approved plan", input.plan),
    section("Assigned item and lease", {
      item: input.itemId,
      epoch: input.epoch,
      base_commit: input.baseCommit,
    }),
    section("Mechanical checkpoint", input.checkpoint ?? null),
    section("Available evidence", input.evidence ?? []),
    "Implement only the assigned item using its details, touches, and acceptance criteria. Do not modify the trusted checks file, push code, open PRs, or publish protocol events; the daemon owns delivery.",
    "Return an advisory skep.work_report/v1: summary, files_intended, concerns, and replan_request. The model cannot declare success; only daemon-captured checks decide success (ARCHITECTURE §9.4).",
    "Use replan_request only when the plan is wrong, with a summary and typed evidence pinned to a commit or an existing daemon journal run. Never fabricate evidence. Otherwise set replan_request to null.",
  ];
}

export function buildWorkPrompt(input: WorkPromptInput): string {
  return [...workContext(input), output(WorkReportSchema)].join("\n\n");
}

export function buildFixupPrompt(input: FixupPromptInput): string {
  return [
    ...workContext(input),
    "This is the single bounded fix-up after failed trusted checks (ARCHITECTURE §9.6). Fix the failures within the assigned scope. The daemon will commit and re-run checks; do not assert that checks passed or request another automatic fix-up.",
    section("Daemon-captured check results", input.checkRuns),
    section("Captured log tail", input.logTail),
    section("Previous advisory report", input.previousReport ?? null),
    output(WorkReportSchema),
  ].join("\n\n");
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  return [
    "Repair the final JSON response to the original invocation. This is the only repair attempt (ARCHITECTURE §9.3).",
    "Correct JSON syntax and schema errors while preserving the intended content and exact task/plan bindings. Do not execute commands, edit files, fabricate evidence, or repeat the original work.",
    "Do not include provider credentials or provider configuration (ARCHITECTURE D19).",
    section("Original prompt", input.originalPrompt),
    section("Previous final message", input.finalMessage),
    section("Validator errors", input.validationErrors),
    "Return exactly one JSON object matching the original schema, without Markdown fences, prose, or extra keys. Omit optional properties instead of filling them with null unless they accept null.",
    section("Original output JSON Schema", input.outputSchema),
  ].join("\n\n");
}
