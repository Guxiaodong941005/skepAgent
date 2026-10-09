import type { AgentId, AttemptId, BarrierId, EventId, ItemId, Sha, TaskId } from "../ids.js";
import type { Budgets, CheckRun } from "../schemas/common.js";
import type { PayloadOf } from "../schemas/events.js";
import type { Plan } from "../schemas/plan.js";

/**
 * Reducer state — the frozen contract between the reducer and everything that reads it (lease
 * intents, CLI status, sim invariants). See docs/ARCHITECTURE.md §5.
 *
 * Rules:
 * - Plain JSON only (no Map/Set/Date/class instances, no `undefined` values), so that
 *   `canonicalJson(state)` is byte-identical across daemons for the same log (invariant 1).
 * - Records keyed by IDs; iteration order never matters to the reducer (use sorted keys if it
 *   ever would).
 * - Derived only from the log + the trust root + REDUCER_VERSION. No clocks, no I/O.
 */

export const REDUCER_VERSION = 1;

export type TaskStatus =
  | "planning"
  | "reviewing"
  | "awaiting_approval"
  | "executing"
  | "interrupting"
  | "replanning"
  | "delivered"
  | "done"
  | "escalated"
  | "cancelled";

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export type ItemStatus =
  | "blocked"
  | "ready"
  | "leased"
  | "delivered"
  | "merged"
  | "interrupted"
  | "unknown"
  | "failed";

export interface AgentRecord {
  agent: AgentId;
  device: string;
  profile: PayloadOf<"agent.registered">;
  registered_seq: number;
}

export interface Lease {
  epoch: number;
  holder: AgentId;
  attempt_id: AttemptId;
  branch: string;
  plan_version: number;
  plan_hash: string;
  granted_at_seq: number;
  /** Barrier that interrupted this lease, if any (PRD §9.7). */
  interrupt: BarrierId | null;
}

export interface Delivery {
  epoch: number;
  branch: string;
  head_sha: Sha;
  submit: PayloadOf<"work.delivered">["submit"];
  check_runs: CheckRun[];
  seq: number;
}

export interface CheckpointRecord {
  epoch: number;
  seq: number;
  barrier_id: BarrierId | null;
  head_sha: Sha | null;
  invocation_state: "completed" | "interrupted" | "killed" | "unknown";
}

export interface ItemState {
  id: ItemId;
  title: string;
  assignee: AgentId;
  depends_on: ItemId[];
  requires: string[];
  status: ItemStatus;
  /** Active (or last interrupted) lease; null when never leased or after release/revoke. */
  lease: Lease | null;
  delivered: Delivery | null;
  submission?: PayloadOf<"work.submitted"> & { seq: number };
  merged: { pr_number: number; merge_sha: Sha; seq: number } | null;
  failure: { epoch: number; class: string; detail: string; seq: number } | null;
  last_checkpoint: CheckpointRecord | null;
  /** Leases granted for this item under the current plan version (for item_retries budget). */
  attempts_this_plan: number;
}

export interface ReviewRecord {
  reviewer: string;
  seq: number;
  verdict: "approve" | "block" | "comment";
  payload: PayloadOf<"review.submitted">;
}

export interface PlanRecord {
  version: number;
  plan_hash: string;
  plan: Plan;
  base_commit: Sha;
  reviewers: AgentId[];
  proposed_seq: number;
  owner_gen: number;
  reviews: Record<string, ReviewRecord>;
  locked: {
    seq: number;
    overrides: PayloadOf<"plan.locked">["overrides"];
    missing_reviews: AgentId[];
  } | null;
  decision: { kind: "approved" | "rejected"; seq: number; note: string | null } | null;
}

export interface BarrierRequest {
  seq: number;
  event_id: EventId;
  actor: string;
  summary: string;
  evidence_count: number;
}

export interface Barrier {
  id: BarrierId;
  opened_seq: number;
  /** Seq at which all awaited items were settled or `barrier.closed` landed; null while open. */
  closed_seq: number | null;
  /** Requests coalesced into this barrier (first one opened it). */
  requests: BarrierRequest[];
  /** Items that held an active lease when the barrier opened. */
  awaiting: ItemId[];
  /** Subset of `awaiting` that has recorded a checkpoint for this barrier. */
  checkpointed: ItemId[];
  /** True when the opening request exceeded the replan budget ⇒ escalate instead of replanning. */
  escalate: boolean;
}

export interface TaskState {
  task_id: TaskId;
  status: TaskStatus;
  created_seq: number;
  /** Accepted events for this task so far (`pre.task_rev`). */
  rev: number;
  last_seq: number;

  title: string;
  body: string;
  repo: string;
  base_branch: string;
  mode: "solo" | "team";
  submit?: PayloadOf<"task.created">["submit"];
  plan_approval: "human" | "owner";
  budgets: Budgets;

  owner: AgentId;
  /** Owner generation, starts at 1; bumped by owner.transferred / human.decided(reassign). */
  owner_gen: number;

  /** All proposed plan versions, keyed by String(version). */
  plans: Record<string, PlanRecord>;
  /** Latest proposed version, or null before the first proposal. */
  current_plan_version: number | null;
  /** Version that was approved (or owner-locked) and is executing; null otherwise. */
  active_plan_version: number | null;

  /** Blocked/rejected plan versions so far (review-round budget). */
  review_rounds: number;
  /** Barriers opened so far (replan budget). */
  replan_count: number;
  /** Current barrier; kept through `replanning` (for coalescing) until a plan is activated. */
  barrier: Barrier | null;

  /** Highest epoch ever granted per item ID; survives plan versions (PRD §9.5). */
  epochs: Record<ItemId, number>;
  /** Items of the active plan (empty before the first approval). */
  items: Record<ItemId, ItemState>;

  escalation: { reason: string; seq: number } | null;
  verified: { top_of_stack_sha: Sha; passed: boolean; seq: number } | null;
  cancelled: { reason: string; seq: number } | null;
}

export type OutcomeKind = "accepted" | "rejected" | "invalid" | "duplicate";

/** One record per log position ≥ 1, for `skep log`, audit (G6) and invariants. */
export interface LogOutcome {
  seq: number;
  sha: Sha;
  outcome: OutcomeKind;
  /** Rejection/invalidity reason (see RejectReason / InvalidReason). */
  reason: string | null;
  event_id: EventId | null;
  type: string | null;
  task_id: TaskId | null;
  actor: string | null;
  signer: string | null;
}

export interface State {
  reducer_version: number;
  protocol_version: number;
  blackboard_id: string;
  genesis_sha: Sha;
  /** Sha and seq of the last applied commit. */
  tip: Sha;
  seq: number;
  agents: Record<AgentId, AgentRecord>;
  tasks: Record<TaskId, TaskState>;
  /** event_id → seq where it was first seen (accepted OR rejected; PRD §8.2 rule 5). */
  seen_event_ids: Record<EventId, number>;
  outcomes: LogOutcome[];
}

/** Structural violations (PRD §8.2 rules 1–4, plus parse failures): no-op + alarm. */
export type InvalidReason =
  | "not_linear"
  | "parent_mismatch"
  | "unsigned"
  | "bad_signature"
  | "unknown_signer"
  | "not_single_add"
  | "bad_event_path"
  | "unreadable_event"
  | "schema_invalid"
  | "path_mismatch";

/** Semantic rejections: recorded, no state change. */
export type RejectReason =
  | "stale_tip"
  | "unauthorized"
  | "unknown_task"
  | "task_exists"
  | "task_terminal"
  | "bad_task_state"
  | "pre_mismatch"
  | "unknown_agent"
  | "invalid_plan"
  | "plan_hash_mismatch"
  | "plan_changed"
  | "unknown_plan_version"
  | "not_reviewer"
  | "unknown_item"
  | "item_not_ready"
  | "not_assignee"
  | "epoch_mismatch"
  | "fenced"
  | "interrupted"
  | "barrier_open"
  | "no_barrier"
  | "max_parallel"
  | "retry_budget"
  | "bad_branch"
  | "bad_snapshot"
  | "missing_evidence"
  | "bad_decision";

/** Result of applying one event to a draft state. Handlers mutate the draft only when ok. */
export type ApplyResult = { ok: true } | { ok: false; reason: RejectReason; detail?: string };
