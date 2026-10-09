import { z } from "zod";
import {
  ActorSchema,
  AgentCliSchema,
  AgentIdSchema,
  AttemptIdSchema,
  BarrierIdSchema,
  BudgetsSchema,
  CheckRunSchema,
  EpochSchema,
  EventIdSchema,
  ItemIdSchema,
  LongTextSchema,
  MAX_EVENT_BYTES,
  NonNegIntSchema,
  PositiveIntSchema,
  RepoRefSchema,
  RoleSchema,
  Sha256TaggedSchema,
  ShaSchema,
  ShortTextSchema,
  TaskIdSchema,
  TimestampSchema,
} from "./common.js";
import { EvidenceSchema } from "./evidence.js";
import { PlanSchema } from "./plan.js";
import { ReviewPayloadSchema } from "./review.js";
import { SnapshotSchema } from "./snapshot.js";

/**
 * Blackboard event envelope `skep.event/v1` and the payload of every MVP event type
 * (PRD §8.4, §8.5). This file is the protocol freeze: changing an existing shape requires a new
 * schema version and a reducer version bump (see docs/ARCHITECTURE.md §4).
 */

export const EVENT_SCHEMA = "skep.event/v1";

/**
 * Preconditions: every fact the action depends on (PRD §8.4). All keys optional at the schema
 * level; `REQUIRED_PRE` lists the keys each type must carry. The reducer rejects the event if any
 * present key disagrees with state at the event's position.
 */
export const PreSchema = z.strictObject({
  /** Number of accepted events for the task before this one. */
  task_rev: NonNegIntSchema.optional(),
  owner_gen: PositiveIntSchema.optional(),
  plan_version: PositiveIntSchema.optional(),
  plan_hash: Sha256TaggedSchema.optional(),
  item: ItemIdSchema.optional(),
  /** Current epoch of `item` (0 if never leased). */
  expected_epoch: NonNegIntSchema.optional(),
});
export type Pre = z.infer<typeof PreSchema>;

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------

export const AgentRegisteredPayload = z.strictObject({
  role: RoleSchema,
  agent_cli: AgentCliSchema,
  cli_version: z.string().min(1).max(64),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  requires_local: z.array(z.string().min(1).max(64)).max(16),
  max_parallel_items: PositiveIntSchema.max(8),
});

export const TaskCreatedPayload = z.strictObject({
  title: ShortTextSchema,
  /** English task body; the only text agents receive. */
  body: LongTextSchema,
  repo: RepoRefSchema,
  base_branch: z.string().min(1).max(255),
  mode: z.enum(["solo", "team"]),
  submit: z.enum(["device", "pr", "mr", "push", "none", "ask"]).default("device"),
  owner: AgentIdSchema,
  budgets: BudgetsSchema,
  plan_approval: z.enum(["human", "owner"]),
  /** Verbatim original (e.g. Chinese) text for audit; never shown to agents (PRD §14). */
  original_text: z.string().max(16_000).optional(),
  original_lang: z.string().min(2).max(16).optional(),
});

export const TaskCancelledPayload = z.strictObject({ reason: ShortTextSchema });

export const OwnerTransferredPayload = z.strictObject({ new_owner: AgentIdSchema });

export const PlanProposedPayload = z.strictObject({
  version: PositiveIntSchema,
  parent_version: PositiveIntSchema.nullable(),
  plan: PlanSchema,
  /** contentHash(plan) — recomputed and checked by the reducer. */
  plan_hash: Sha256TaggedSchema,
  base_commit: ShaSchema,
  /** Frozen reviewer set (team mode: exactly one peer in the MVP; solo: empty). */
  reviewers: z.array(AgentIdSchema).max(4),
});

export const ReviewSubmittedPayload = ReviewPayloadSchema;

export const PlanLockedPayload = z.strictObject({
  plan_version: PositiveIntSchema,
  plan_hash: Sha256TaggedSchema,
  overrides: z
    .array(
      z.strictObject({
        reviewer: ActorSchema,
        blocker_id: z.string().regex(/^B\d{1,3}$/),
        rationale: z.string().min(1).max(2000),
      }),
    )
    .max(32),
  missing_reviews: z.array(AgentIdSchema).max(4),
});

export const PlanDecisionPayload = z.strictObject({
  plan_version: PositiveIntSchema,
  plan_hash: Sha256TaggedSchema,
  note: z.string().max(2000).optional(),
});

export const LeaseClaimedPayload = z.strictObject({
  item: ItemIdSchema,
  attempt_id: AttemptIdSchema,
  /** Must equal workBranch(task, item, expected_epoch + 1). */
  branch: z.string().min(1).max(255),
});

export const LeaseReleasedPayload = z.strictObject({
  item: ItemIdSchema,
  epoch: EpochSchema,
  reason: ShortTextSchema,
});

export const LeaseRevokedPayload = z.strictObject({
  item: ItemIdSchema,
  epoch: EpochSchema,
  reason: ShortTextSchema,
  /** OID of the stale `hb/<agent>` ref the revoker saw (V1 owner revocation); null for human. */
  observed_hb: ShaSchema.nullable(),
});

export const CheckpointRecordedPayload = z.strictObject({
  item: ItemIdSchema,
  epoch: EpochSchema,
  /** The barrier this checkpoint satisfies, or null for a voluntary checkpoint. */
  barrier_id: BarrierIdSchema.nullable(),
  snapshot: SnapshotSchema,
});

const submissionFields = {
  method: z.enum(["pr", "mr", "push", "none", "ask"]),
  state: z.enum(["opened", "pushed", "local", "pending"]),
  pr_url: z.url().max(512).optional(),
  pr_number: PositiveIntSchema.optional(),
};

function validSubmission(p: {
  method: string;
  state: string;
  pr_url?: string;
  pr_number?: number;
}): boolean {
  const opened = p.state === "opened";
  if (opened !== (p.pr_url !== undefined) || opened !== (p.pr_number !== undefined)) return false;
  if (p.state === "skipped") return p.method === "none";
  const states: Record<string, string> = {
    pr: "opened",
    mr: "opened",
    push: "pushed",
    none: "local",
    ask: "pending",
  };
  return states[p.method] === p.state;
}

export const DeliverySubmitSchema = z.strictObject(submissionFields).refine(validSubmission, {
  message: "submit method and state must agree; PR URL and number are required iff opened",
});

export const WorkDeliveredPayload = z.strictObject({
  item: ItemIdSchema,
  epoch: EpochSchema,
  branch: z.string().min(1).max(255),
  head_sha: ShaSchema,
  submit: DeliverySubmitSchema,
  check_runs: z.array(CheckRunSchema).max(32),
});

export const WorkSubmittedPayload = z
  .strictObject({
    ...submissionFields,
    item: ItemIdSchema,
    epoch: EpochSchema,
    method: z.enum(["pr", "mr", "push", "none"]),
    state: z.enum(["opened", "pushed", "local", "skipped"]),
    head_sha: ShaSchema,
  })
  .refine(validSubmission, {
    message: "submission method and state must agree; PR URL and number are required iff opened",
  });

export const WorkFailureClassSchema = z.enum([
  "invalid_output",
  "checks_failed",
  "timeout",
  "permission_prompt",
  "crash",
  "preflight",
  "secret_detected",
  /** Task invocation/wall-time budget exhausted on this device ⇒ escalate (PRD §9.9). */
  "budget_exceeded",
]);

export const WorkFailedPayload = z.strictObject({
  item: ItemIdSchema,
  epoch: EpochSchema,
  class: WorkFailureClassSchema,
  detail: z.string().min(1).max(4000),
});

export const ReplanRequestedPayload = z.strictObject({
  summary: z.string().min(1).max(4000),
  /** ≥ 1 verified evidence item unless the actor is the human (PRD §9.9). */
  evidence: z.array(EvidenceSchema).max(8),
  /** Item whose execution surfaced the problem, if any. */
  item: ItemIdSchema.nullable(),
});

export const BarrierClosedPayload = z.strictObject({
  barrier_id: BarrierIdSchema,
  missing: z.array(ItemIdSchema).max(8),
});

export const ItemMergedPayload = z.strictObject({
  item: ItemIdSchema,
  pr_number: PositiveIntSchema,
  merge_sha: ShaSchema,
});

export const TaskVerifiedPayload = z.strictObject({
  top_of_stack_sha: ShaSchema,
  check_runs: z.array(CheckRunSchema).max(64),
  passed: z.boolean(),
});

export const HumanDecidedPayload = z
  .strictObject({
    decision: z.enum(["resume_with_plan", "replan", "cancel", "reassign_owner"]),
    note: z.string().max(2000).optional(),
    /** Required iff decision is `reassign_owner`. */
    new_owner: AgentIdSchema.optional(),
  })
  .refine((p) => (p.decision === "reassign_owner") === (p.new_owner !== undefined), {
    message: "new_owner is required iff decision is reassign_owner",
  });

// ---------------------------------------------------------------------------------------------
// Envelope + discriminated union
// ---------------------------------------------------------------------------------------------

const envelopeBase = {
  schema: z.literal(EVENT_SCHEMA),
  event_id: EventIdSchema,
  actor: ActorSchema,
  /** Blackboard `main` tip the event was computed against; must equal the commit's parent. */
  observed_tip: ShaSchema,
  pre: PreSchema,
  /** Display only. */
  created_at: TimestampSchema,
  lang: z.literal("en"),
};

function taskEvent<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ ...envelopeBase, type: z.literal(type), task_id: TaskIdSchema, payload });
}

function clusterEvent<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ ...envelopeBase, type: z.literal(type), task_id: z.null(), payload });
}

export const EVENT_SCHEMAS = {
  "agent.registered": clusterEvent("agent.registered", AgentRegisteredPayload),
  "task.created": taskEvent("task.created", TaskCreatedPayload),
  "task.cancelled": taskEvent("task.cancelled", TaskCancelledPayload),
  "owner.transferred": taskEvent("owner.transferred", OwnerTransferredPayload),
  "plan.proposed": taskEvent("plan.proposed", PlanProposedPayload),
  "review.submitted": taskEvent("review.submitted", ReviewSubmittedPayload),
  "plan.locked": taskEvent("plan.locked", PlanLockedPayload),
  "plan.approved": taskEvent("plan.approved", PlanDecisionPayload),
  "plan.rejected": taskEvent("plan.rejected", PlanDecisionPayload),
  "lease.claimed": taskEvent("lease.claimed", LeaseClaimedPayload),
  "lease.released": taskEvent("lease.released", LeaseReleasedPayload),
  "lease.revoked": taskEvent("lease.revoked", LeaseRevokedPayload),
  "checkpoint.recorded": taskEvent("checkpoint.recorded", CheckpointRecordedPayload),
  "work.delivered": taskEvent("work.delivered", WorkDeliveredPayload),
  "work.submitted": taskEvent("work.submitted", WorkSubmittedPayload),
  "work.failed": taskEvent("work.failed", WorkFailedPayload),
  "replan.requested": taskEvent("replan.requested", ReplanRequestedPayload),
  "barrier.closed": taskEvent("barrier.closed", BarrierClosedPayload),
  "item.merged": taskEvent("item.merged", ItemMergedPayload),
  "task.verified": taskEvent("task.verified", TaskVerifiedPayload),
  "human.decided": taskEvent("human.decided", HumanDecidedPayload),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export const EventSchema = z.discriminatedUnion("type", [
  EVENT_SCHEMAS["agent.registered"],
  EVENT_SCHEMAS["task.created"],
  EVENT_SCHEMAS["task.cancelled"],
  EVENT_SCHEMAS["owner.transferred"],
  EVENT_SCHEMAS["plan.proposed"],
  EVENT_SCHEMAS["review.submitted"],
  EVENT_SCHEMAS["plan.locked"],
  EVENT_SCHEMAS["plan.approved"],
  EVENT_SCHEMAS["plan.rejected"],
  EVENT_SCHEMAS["lease.claimed"],
  EVENT_SCHEMAS["lease.released"],
  EVENT_SCHEMAS["lease.revoked"],
  EVENT_SCHEMAS["checkpoint.recorded"],
  EVENT_SCHEMAS["work.delivered"],
  EVENT_SCHEMAS["work.submitted"],
  EVENT_SCHEMAS["work.failed"],
  EVENT_SCHEMAS["replan.requested"],
  EVENT_SCHEMAS["barrier.closed"],
  EVENT_SCHEMAS["item.merged"],
  EVENT_SCHEMAS["task.verified"],
  EVENT_SCHEMAS["human.decided"],
]);

export type SkepEvent = z.infer<typeof EventSchema>;
export type EventOf<T extends EventType> = Extract<SkepEvent, { type: T }>;
export type PayloadOf<T extends EventType> = EventOf<T>["payload"];

/** Pre keys each event type must carry (in addition to whatever else it declares). */
export const REQUIRED_PRE: Record<EventType, readonly (keyof Pre)[]> = {
  "agent.registered": [],
  "task.created": [],
  "task.cancelled": ["task_rev"],
  "owner.transferred": ["task_rev", "owner_gen"],
  "plan.proposed": ["task_rev", "owner_gen"],
  "review.submitted": ["task_rev", "plan_version", "plan_hash"],
  "plan.locked": ["task_rev", "owner_gen", "plan_version", "plan_hash"],
  "plan.approved": ["task_rev", "plan_version", "plan_hash"],
  "plan.rejected": ["task_rev", "plan_version", "plan_hash"],
  "lease.claimed": ["task_rev", "plan_version", "plan_hash", "item", "expected_epoch"],
  "lease.released": ["task_rev", "item"],
  "lease.revoked": ["task_rev", "item"],
  "checkpoint.recorded": ["task_rev", "item"],
  "work.delivered": ["task_rev", "item"],
  "work.submitted": ["task_rev", "item"],
  "work.failed": ["task_rev", "item"],
  "replan.requested": ["task_rev"],
  "barrier.closed": ["task_rev"],
  "item.merged": ["task_rev", "item"],
  "task.verified": ["task_rev", "owner_gen", "plan_hash"],
  "human.decided": ["task_rev"],
};

export type ParseEventResult = { ok: true; event: SkepEvent } | { ok: false; error: string };

/** Validate an already-parsed JSON value as an event (schema + required preconditions). */
export function parseEvent(raw: unknown): ParseEventResult {
  const r = EventSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const missing = REQUIRED_PRE[r.data.type].filter((k) => r.data.pre[k] === undefined);
  if (missing.length > 0) {
    return { ok: false, error: `missing required pre: ${missing.join(", ")}` };
  }
  return { ok: true, event: r.data };
}

/** Parse an event file's bytes: size limit (64 KiB), UTF-8 JSON, then `parseEvent`. */
export function parseEventFile(bytes: Uint8Array | string): ParseEventResult {
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength;
  if (size > MAX_EVENT_BYTES) return { ok: false, error: `event exceeds ${MAX_EVENT_BYTES} bytes` };
  let raw: unknown;
  try {
    const text =
      typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  return parseEvent(raw);
}

/** Serialize an event for the blackboard: 2-space JSON + trailing newline (human-diffable). */
export function serializeEvent(event: SkepEvent): string {
  return `${JSON.stringify(event, null, 2)}\n`;
}
