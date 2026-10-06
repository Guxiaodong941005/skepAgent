import { z } from "zod";
import {
  AgentIdSchema,
  ItemIdSchema,
  LongTextSchema,
  NonNegIntSchema,
  PositiveIntSchema,
  RelPathSchema,
  RepoRefSchema,
  RoleSchema,
  ShaSchema,
  ShortTextSchema,
  TaskIdSchema,
} from "./common.js";

/** MVP limit on items per plan (PRD §9.2). */
export const MAX_PLAN_ITEMS = 4;

export const AcceptanceSchema = z.discriminatedUnion("kind", [
  /** A named check from the trusted `.skep/checks.toml` at `base.commit`. */
  z.strictObject({ kind: z.literal("check"), name: z.string().min(1).max(64) }),
  /** Human-verified criterion; informational for the agent and the human. */
  z.strictObject({ kind: z.literal("manual"), text: ShortTextSchema }),
]);
export type Acceptance = z.infer<typeof AcceptanceSchema>;

export const PlanItemSchema = z.strictObject({
  id: ItemIdSchema,
  title: ShortTextSchema,
  /** Implementation instructions handed to the assignee's agent. */
  details: LongTextSchema.optional(),
  role: RoleSchema,
  assignee: AgentIdSchema,
  depends_on: z.array(ItemIdSchema).max(1),
  requires: z.array(z.string().min(1).max(64)).max(16).optional(),
  touches: z.array(RelPathSchema).max(64),
  risk: z.enum(["normal", "high"]),
  acceptance: z.array(AcceptanceSchema).min(1).max(16),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/**
 * `skep.plan/v1` — produced by the owner's model, validated by the owner's daemon before
 * `plan.proposed` is published (PRD §9.2). Structural checks that need no external context are
 * done here; checks that need the registry or the code repo live in the plan validator.
 */
export const PlanSchema = z
  .strictObject({
    schema: z.literal("skep.plan/v1"),
    task_id: TaskIdSchema,
    version: PositiveIntSchema,
    parent_version: NonNegIntSchema.nullable(),
    base: z.strictObject({
      repo: RepoRefSchema,
      branch: z.string().min(1).max(255),
      commit: ShaSchema,
    }),
    mode: z.enum(["solo", "team"]),
    summary: LongTextSchema,
    items: z.array(PlanItemSchema).min(1).max(MAX_PLAN_ITEMS),
    stack_order: z.array(ItemIdSchema).min(1).max(MAX_PLAN_ITEMS),
    changes_from_parent: z.string().max(4000).nullable(),
  })
  .superRefine((plan, ctx) => {
    const ids = plan.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "duplicate item ids" });
      return;
    }
    if (
      plan.stack_order.length !== ids.length ||
      new Set(plan.stack_order).size !== ids.length ||
      !plan.stack_order.every((id) => ids.includes(id))
    ) {
      ctx.addIssue({ code: "custom", message: "stack_order must be a permutation of item ids" });
      return;
    }
    // MVP: linear chain. stack_order[0] has no deps; stack_order[k] depends exactly on [k-1].
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    plan.stack_order.forEach((id, k) => {
      const deps = byId.get(id)?.depends_on ?? [];
      const expected = k === 0 ? [] : [plan.stack_order[k - 1]];
      if (deps.length !== expected.length || deps[0] !== expected[0]) {
        ctx.addIssue({
          code: "custom",
          message: `item ${id}: depends_on must be ${JSON.stringify(expected)} (linear stack)`,
        });
      }
    });
    if (plan.version === 1 ? plan.parent_version !== null : plan.parent_version === null) {
      ctx.addIssue({ code: "custom", message: "parent_version must be null iff version is 1" });
    }
  });
export type Plan = z.infer<typeof PlanSchema>;
