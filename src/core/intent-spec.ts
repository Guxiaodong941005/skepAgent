/**
 * `intentFromSpec` — the one mapping from a CLI intent spec to a pure {@link Intent}
 * (ARCHITECTURE §12).
 *
 * SK-601's publish handler calls this (injected as `resolveIntent`) and so does the CLI's
 * in-process fallback, which is what keeps the two paths identical: both re-derive the draft
 * from the state the publisher replays and both return `null` when that state cannot accept the
 * action.
 *
 * The schema lives here, in `core`, because that is the direction the dependency graph allows
 * (ARCHITECTURE §2): `ipc/protocol.ts` re-exports {@link IntentSpecSchema} so the socket frames
 * and this mapping cannot drift apart. A handler that forwards the raw `params.intent` fails
 * closed instead of publishing a guess.
 *
 * `task.create` is the one spec whose draft is not fully determined by state: the task id is
 * minted once per publication (PRD §10.2) and then stays fixed across the write-loop retries.
 */

import { z } from "zod";
import { newTaskId, type RandomSource } from "../util/random.js";
import type { Intent } from "./intents.js";
import {
  humanDecideIntent,
  leaseRevokeIntent,
  planApproveIntent,
  planRejectIntent,
  replanRequestIntent,
  type TaskCreateInput,
  taskCancelIntent,
  taskCreateIntent,
} from "./intents-human.js";
import {
  AgentIdSchema,
  EpochSchema,
  ItemIdSchema,
  RepoRefSchema,
  Sha256TaggedSchema,
  ShortTextSchema,
  TaskIdSchema,
} from "./schemas/common.js";
import { EvidenceSchema } from "./schemas/evidence.js";

/** `skep task new`. Budgets and the task id are re-derived; the spec only states the ask. */
const TaskCreateSpec = z.strictObject({
  kind: z.literal("task.create"),
  title: ShortTextSchema,
  body: z.string().min(1).max(16_000),
  repo: RepoRefSchema,
  base_branch: z.string().min(1).max(255).optional(),
  mode: z.enum(["solo", "team"]),
  owner: AgentIdSchema.optional(),
  original_text: z.string().max(16_000).optional(),
  original_lang: z.string().min(2).max(16).optional(),
});

/** `skep task cancel`. */
const TaskCancelSpec = z.strictObject({
  kind: z.literal("task.cancel"),
  task: TaskIdSchema,
  reason: ShortTextSchema,
});

/** `skep plan approve`. `plan_hash` is what the human saw; state decides whether it is current. */
const PlanApproveSpec = z.strictObject({
  kind: z.literal("plan.approve"),
  task: TaskIdSchema,
  plan_hash: Sha256TaggedSchema.optional(),
  note: z.string().max(2000).optional(),
});

/** `skep plan reject`. */
const PlanRejectSpec = z.strictObject({
  kind: z.literal("plan.reject"),
  task: TaskIdSchema,
  plan_hash: Sha256TaggedSchema.optional(),
  note: z.string().max(2000).optional(),
});

/** `skep lease revoke` (ARCHITECTURE §6.4): human-signed, no heartbeat evidence in the MVP. */
const LeaseRevokeSpec = z.strictObject({
  kind: z.literal("lease.revoke"),
  task: TaskIdSchema,
  item: ItemIdSchema,
  epoch: EpochSchema,
  reason: ShortTextSchema.optional(),
});

/** `skep decide`. `new_owner` is required exactly when the decision transfers ownership. */
const DecideSpec = z
  .strictObject({
    kind: z.literal("decide"),
    task: TaskIdSchema,
    decision: z.enum(["resume_with_plan", "replan", "cancel", "reassign_owner"]),
    new_owner: AgentIdSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((spec) => (spec.decision === "reassign_owner") === (spec.new_owner !== undefined), {
    message: "new_owner is required iff decision is reassign_owner",
  });

/**
 * `skep replan`. Evidence is optional: a human request needs none (PRD §9.9). The intent drops
 * itself when the task can no longer be replanned.
 */
const ReplanSpec = z.strictObject({
  kind: z.literal("replan.request"),
  task: TaskIdSchema,
  reason: z.string().min(1).max(4000),
  evidence: z.array(EvidenceSchema).max(8).optional(),
  item: ItemIdSchema.nullable().optional(),
});

/**
 * Every CLI write kind (ARCHITECTURE §12). Re-exported by `ipc/protocol.ts` so the socket frames
 * validate with exactly this schema.
 */
export const IntentSpecSchema = z.discriminatedUnion("kind", [
  TaskCreateSpec,
  TaskCancelSpec,
  PlanApproveSpec,
  PlanRejectSpec,
  LeaseRevokeSpec,
  DecideSpec,
  ReplanSpec,
]);

export type IntentSpec = z.infer<typeof IntentSpecSchema>;

export interface IntentSpecContext {
  /** Draws the task id for `task.create`. Ignored for every other kind. */
  rng: RandomSource;
  /** Wall time the task id's date is taken from. Display only (PRD §9.1). */
  nowMs: number;
}

/**
 * The intent a spec describes, or `null` when `spec` is not a valid {@link IntentSpec}.
 *
 * A valid spec always yields an intent; that intent is what returns `null` at publish time when
 * the replayed state cannot accept it.
 */
export function intentFromSpec(spec: unknown, ctx: IntentSpecContext): Intent | null {
  const parsed = IntentSpecSchema.safeParse(spec);
  if (!parsed.success) return null;
  return intentFor(parsed.data, ctx);
}

function intentFor(spec: IntentSpec, ctx: IntentSpecContext): Intent {
  switch (spec.kind) {
    case "task.create":
      return taskCreateIntent(taskCreateInput(spec), newTaskId(ctx.rng, ctx.nowMs));
    case "task.cancel":
      return taskCancelIntent(spec.task, spec.reason);
    case "plan.approve":
      return planApproveIntent(spec.task, { planHash: spec.plan_hash, note: spec.note });
    case "plan.reject":
      return planRejectIntent(spec.task, { planHash: spec.plan_hash, note: spec.note });
    case "lease.revoke":
      return leaseRevokeIntent(spec.task, spec.item, spec.epoch, spec.reason);
    case "decide":
      return humanDecideIntent(spec.task, spec.decision, {
        newOwner: spec.new_owner,
        note: spec.note,
      });
    case "replan.request":
      return replanRequestIntent(spec.task, spec.reason, {
        evidence: spec.evidence,
        item: spec.item,
      });
  }
}

/** The spec already carries the ask; this only renames it to the builder's input. */
function taskCreateInput(spec: Extract<IntentSpec, { kind: "task.create" }>): TaskCreateInput {
  return {
    title: spec.title,
    body: spec.body,
    repo: spec.repo,
    baseBranch: spec.base_branch,
    mode: spec.mode,
    owner: spec.owner,
    originalText: spec.original_text,
    originalLang: spec.original_lang,
  };
}
