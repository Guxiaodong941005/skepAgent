import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGETS } from "../core/schemas/common.js";
import type { Evidence } from "../core/schemas/evidence.js";
import type { Plan } from "../core/schemas/plan.js";
import {
  buildFixupPrompt,
  buildPlanPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
  type FixupPromptInput,
  type PlanPromptInput,
  type RepairPromptInput,
  type ReviewPromptInput,
  type WorkPromptInput,
} from "./prompts.js";

const plan: Plan = {
  schema: "skep.plan/v1",
  task_id: "T-20261006-307a",
  version: 1,
  parent_version: null,
  base: { repo: "https://example.invalid/repo.git", branch: "main", commit: "a".repeat(40) },
  mode: "solo",
  summary: "Add an example feature.",
  items: [
    {
      id: "W1",
      title: "Example feature",
      details: "Implement the example module.",
      role: "coding",
      assignee: "vps.coding",
      depends_on: [],
      touches: ["src/example.ts"],
      risk: "normal",
      acceptance: [{ kind: "check", name: "unit" }],
    },
  ],
  stack_order: ["W1"],
  changes_from_parent: null,
};
const evidence: Evidence = {
  id: "ev_1",
  type: "file_span",
  repo: plan.base.repo,
  commit: plan.base.commit,
  path: "src/example.ts",
  lines: [1, 1],
  sha256: "0".repeat(64),
  excerpt: "Example line.",
};
const context = {
  agentInstructions: "Follow the coding role policy.",
  repoContext: "Example repository context.",
};
const planInput: PlanPromptInput = {
  ...context,
  task: {
    task_id: plan.task_id,
    title: "Example task",
    body: "Implement the example feature.",
    repo: plan.base.repo,
    base_branch: "main",
    mode: "solo",
    budgets: DEFAULT_BUDGETS,
  },
  baseCommit: plan.base.commit,
  version: 2,
  parentPlan: plan,
  agents: [
    {
      agent: "vps.coding",
      device: "vps",
      role: "coding",
      capabilities: ["node"],
      requires_local: [],
    },
  ],
  checks: ["unit"],
  evidence: [evidence],
  checkpoints: [{ item: "W1", head_sha: plan.base.commit }],
};
const reviewInput: ReviewPromptInput = {
  ...context,
  plan,
  planHash: `sha256:${"1".repeat(64)}`,
  evidence: [evidence],
};
const workInput: WorkPromptInput = {
  ...context,
  plan,
  itemId: "W1",
  epoch: 2,
  baseCommit: "b".repeat(40),
  evidence: [evidence],
  checkpoint: { item: "W1", head_sha: "c".repeat(40) },
};
const fixupInput: FixupPromptInput = {
  ...workInput,
  logTail: "Example check failed: expected true.",
  checkRuns: [
    {
      run_id: "run_1",
      check: "unit",
      sha: "b".repeat(40),
      exit: 1,
      duration_ms: 12,
      log_sha256: "2".repeat(64),
    },
  ],
  previousReport: {
    schema: "skep.work_report/v1",
    summary: "Example change.",
    files_intended: ["src/example.ts"],
    concerns: [],
    replan_request: null,
  },
};
const repairInput: RepairPromptInput = {
  originalPrompt: "Implement the example item.",
  finalMessage: '{"summary":3}',
  validationErrors: "summary: expected string",
  outputSchema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
};

describe("prompt builders", () => {
  it("are pure functions of explicit inputs, without accessing process.env or mutating arguments", () => {
    const buildAll = () => [
      buildPlanPrompt(planInput),
      buildReviewPrompt(reviewInput),
      buildWorkPrompt(workInput),
      buildFixupPrompt(fixupInput),
      buildRepairPrompt(repairInput),
    ];
    const inputs = [planInput, reviewInput, workInput, fixupInput, repairInput];
    const before = structuredClone(inputs);
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    if (!descriptor) throw new Error("Expected the Node environment property.");
    let accesses = 0;
    let first: string[];
    let second: string[];
    try {
      Object.defineProperty(process, "env", {
        configurable: true,
        get() {
          accesses++;
          throw new Error("Prompt builders must not read process.env.");
        },
      });
      first = buildAll();
      second = buildAll();
    } finally {
      Object.defineProperty(process, "env", descriptor);
    }
    expect(first).toEqual(second);
    expect(accesses).toBe(0);
    expect(inputs).toEqual(before);
  });

  it("plans with task, pinned base, profiles, trusted checks, and replan context", () => {
    const prompt = buildPlanPrompt(planInput);
    for (const expected of [
      context.agentInstructions,
      context.repoContext,
      plan.task_id,
      plan.base.commit,
      "vps.coding",
      "unit",
      "head_sha",
      "ev_1",
      "changes_from_parent",
      "skep.plan/v1",
    ]) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).toContain("linear stack");
    expect(prompt).toContain("solo plan has exactly one item");
    expect(prompt).toContain("team task must keep team mode");
    expect(prompt).toContain("at most four items");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("do not invent commands");
    expect(prompt).toContain('"additionalProperties": false');
  });

  it("binds reviews to the exact plan and allows approval without invented objections", () => {
    const prompt = buildReviewPrompt(reviewInput);
    expect(prompt).toContain(reviewInput.planHash);
    expect(prompt).toContain('"plan_version": 1');
    expect(prompt).toContain("Approve when no blocker is found");
    expect(prompt).toContain("Do not object for its own sake");
    expect(prompt).toContain("at least one concrete blocker with evidence");
    expect(prompt).toContain("never invent hashes");
    expect(prompt).toContain("downgrades a block with no verified evidence to comment");
    expect(prompt).toContain("skep.review/v1");
    expect(prompt).toContain("without editing repository files");
  });

  it("scopes work to the item, epoch, predecessor base, and checkpoint with an advisory report", () => {
    const prompt = buildWorkPrompt(workInput);
    expect(prompt).toContain('"item": "W1"');
    expect(prompt).toContain('"epoch": 2');
    expect(prompt).toContain(workInput.baseCommit);
    expect(prompt).toContain("c".repeat(40));
    expect(prompt).toContain("Implement the example module");
    expect(prompt).toContain("The model cannot declare success");
    expect(prompt).toContain("only daemon-captured checks decide success");
    expect(prompt).toContain("Otherwise set replan_request to null");
    expect(prompt).toContain("Never fabricate evidence");
    expect(prompt).toContain("the daemon owns delivery");
    expect(prompt).toContain("skep.work_report/v1");
  });

  it("fixes failures once using captured check results and logs", () => {
    const prompt = buildFixupPrompt(fixupInput);
    expect(prompt).toContain("single bounded fix-up");
    expect(prompt).toContain("run_1");
    expect(prompt).toContain("b".repeat(40));
    expect(prompt).toContain(fixupInput.logTail);
    expect(prompt).toContain("Previous advisory report");
    expect(prompt).toContain("do not assert that checks passed");
    expect(prompt).toContain("skep.work_report/v1");
  });

  it("repairs JSON with the original output, validator errors, and schema without repeating work", () => {
    const prompt = buildRepairPrompt(repairInput);
    expect(prompt).toContain(repairInput.originalPrompt);
    expect(prompt).toContain(JSON.stringify(repairInput.finalMessage));
    expect(prompt).toContain(repairInput.validationErrors);
    expect(prompt).toContain('"additionalProperties": false');
    expect(prompt).toContain("only repair attempt");
    expect(prompt).toContain("Do not execute commands, edit files");
    expect(prompt).toContain("preserving the intended content and exact task/plan bindings");
  });

  it("reflects changed explicit context and includes the D19 rule in every prompt", () => {
    expect(buildWorkPrompt({ ...workInput, epoch: 3 })).not.toBe(buildWorkPrompt(workInput));
    for (const prompt of [
      buildPlanPrompt(planInput),
      buildReviewPrompt(reviewInput),
      buildWorkPrompt(workInput),
      buildFixupPrompt(fixupInput),
      buildRepairPrompt(repairInput),
    ]) {
      expect(prompt).toContain("provider credentials or provider configuration");
      expect(prompt).toContain("D19");
    }
  });
});
