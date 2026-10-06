import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { replay } from "../core/reducer/replay.js";
import { type PlanValidationContext, PlanValidationError, validatePlan } from "./plan-validator.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function fixture() {
  const log = new LogBuilder();
  for (const actor of [MAC, VPS])
    log.append({
      type: "agent.registered",
      actor,
      payload: {
        ...agentRegistered(),
        capabilities: actor === MAC ? ["typescript", "xcode"] : ["typescript"],
        requires_local: actor === MAC ? ["xcode"] : [],
      },
    });
  log.append({ type: "task.created", actor: "human", payload: taskCreated({ owner: VPS }) });
  const state = replay(log.entries);
  const task = state.tasks[T1];
  if (!task) throw new Error("Missing task fixture");
  const plan = samplePlan();
  const context: PlanValidationContext = {
    state,
    task,
    loadChecks: vi.fn(async () => ({
      schema: "skep.checks/v1" as const,
      checks: {
        unit: {
          argv: ["node", "-e", "process.exit(0)"],
          timeout_sec: 600,
          parser: "none" as const,
        },
      },
    })),
    pathExists: vi.fn(async () => true),
  };
  return { plan, context };
}

describe("owner plan validation", () => {
  it("validates the pinned checks and preserves a solo plan", async () => {
    const { plan, context } = fixture();
    required(plan.items[0]).acceptance = [{ kind: "check", name: "unit" }];
    const result = await validatePlan(plan, context);
    expect(result.reviewers).toEqual([]);
    expect(context.loadChecks).toHaveBeenCalledWith(plan.base.repo, plan.base.commit);
    expect(result.warnings).toEqual([]);
  });
  it.each(["unknown_key", "linear", "five_items", "task", "version", "parent", "repo", "branch"])(
    "rejects invalid %s before publishing",
    async (kind) => {
      const { plan, context } = fixture();
      const input = structuredClone(plan) as unknown as Record<string, unknown>;
      if (kind === "unknown_key") input.extra = true;
      if (kind === "linear") required(plan.items[0]).depends_on = ["W1"];
      if (kind === "five_items")
        plan.items = Array.from({ length: 5 }, (_, i) => ({
          ...required(plan.items[0]),
          id: `W${i + 1}`,
          depends_on: i ? [`W${i}`] : [],
        }));
      if (kind === "task") plan.task_id = "T-20261005-0000";
      if (kind === "version") plan.version = 3;
      if (kind === "parent") {
        plan.version = 2;
        plan.parent_version = 1;
      }
      if (kind === "repo") plan.base.repo = "https://example.invalid/other.git";
      if (kind === "branch") plan.base.branch = "other";
      await expect(
        validatePlan(kind === "unknown_key" ? input : plan, context),
      ).rejects.toBeInstanceOf(PlanValidationError);
    },
  );
  it.each(["registration", "role", "capability", "local", "check"])(
    "rejects mismatched %s",
    async (kind) => {
      const { plan, context } = fixture();
      if (kind === "registration") required(plan.items[0]).assignee = "vps.design";
      if (kind === "role") required(plan.items[0]).role = "design";
      if (kind === "capability") required(plan.items[0]).requires = ["unknown-tool"];
      if (kind === "local") required(plan.items[0]).requires = ["xcode"];
      if (kind === "check")
        required(plan.items[0]).acceptance = [{ kind: "check", name: "unknown-check" }];
      await expect(validatePlan(plan, context)).rejects.toBeInstanceOf(PlanValidationError);
    },
  );
  it("warns for missing touches paths, accepts an existing parent, and binds paths to base", async () => {
    const { plan, context } = fixture();
    required(plan.items[0]).touches = ["src/new.ts", "unknown/new.ts"];
    context.pathExists = vi.fn(async (_repo, _sha, path) => path === "src");
    const result = await validatePlan(plan, context);
    expect(result.warnings).toEqual([
      "Item W1: touches path unknown/new.ts has no existing parent at base commit",
    ]);
    expect(context.pathExists).toHaveBeenCalledWith(plan.base.repo, plan.base.commit, "src/new.ts");
  });
  it("upgrades cross-device work and selects one non-owner reviewer deterministically (D13)", async () => {
    const { plan, context } = fixture();
    required(plan.items[0]).assignee = MAC;
    required(plan.items[0]).requires = ["xcode"];
    const result = await validatePlan(plan, context);
    expect(result.plan.mode).toBe("team");
    expect(result.reviewers).toEqual([MAC]);
    expect(plan.mode).toBe("solo");
  });
  it("upgrades multi-item proposals and rejects team-to-solo downgrades", async () => {
    const { plan, context } = fixture();
    plan.items.push({ ...required(plan.items[0]), id: "W2", assignee: MAC, depends_on: ["W1"] });
    plan.stack_order.push("W2");
    expect((await validatePlan(plan, context)).plan.mode).toBe("team");
    context.task.mode = "team";
    await expect(validatePlan(samplePlan(), context)).rejects.toThrow("downgrade");
  });
  it("requires a non-owner assignee for a team plan", async () => {
    const { plan, context } = fixture();
    plan.mode = "team";
    await expect(validatePlan(plan, context)).rejects.toThrow("non-owner assignee");
  });
});
