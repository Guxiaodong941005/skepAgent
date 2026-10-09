import type { AgentId, EventId, Sha, TaskId } from "./ids.js";
import { workBranch } from "./ids.js";
import { activeLeaseCount } from "./reducer/handlers/lease.js";
import type { State, TaskState } from "./reducer/state.js";
import { type ClaimCandidate, claimableItems } from "./reducer/views.js";
import {
  EVENT_SCHEMA,
  type EventType,
  type PayloadOf,
  type Pre,
  parseEvent,
  type SkepEvent,
  WorkSubmittedPayload,
} from "./schemas/events.js";

// Indexing a concrete map preserves PayloadOf<T> while avoiding Extract's inferred invariance:
// a draft of one event type must be usable as the result of the general Intent contract.
type DraftPayloads = { [T in EventType]: PayloadOf<T> };

export interface EventDraft<T extends EventType = EventType> {
  type: T;
  task_id: TaskId | null;
  actor: string;
  pre: Pre;
  payload: DraftPayloads[T];
}

export type Intent = (state: State) => EventDraft | null;

export class EventDraftError extends Error {
  constructor(message: string) {
    super(`Cannot finalize event draft: ${message}`);
    this.name = "EventDraftError";
  }
}

export function draft<T extends EventType>(
  type: T,
  taskId: TaskId | null,
  actor: string,
  payload: PayloadOf<T>,
  pre: Pre,
): EventDraft<T>;
export function draft(
  type: EventType,
  taskId: TaskId | null,
  actor: string,
  payload: PayloadOf<EventType>,
  pre: Pre,
): EventDraft {
  return { type, task_id: taskId, actor, payload, pre };
}

export function finalizeEvent(
  eventDraft: EventDraft,
  metadata: { event_id: EventId; observed_tip: Sha; created_at: string },
): SkepEvent {
  const parsed = parseEvent({
    ...eventDraft,
    ...metadata,
    schema: EVENT_SCHEMA,
    lang: "en",
  });
  if (!parsed.ok) throw new EventDraftError(parsed.error);
  return parsed.event;
}

// Pin attempt identity and completed result data, but re-read every state precondition (§6.1–6.3).
type AgentAction = { task_id: TaskId; actor: AgentId };
export type ClaimIntentOptions = AgentAction & Omit<PayloadOf<"lease.claimed">, "branch">;
export type ReleaseIntentOptions = AgentAction & PayloadOf<"lease.released">;
export type RevokeIntentOptions = { task_id: TaskId } & Omit<
  PayloadOf<"lease.revoked">,
  "observed_hb"
>;
export type DeliverIntentOptions = AgentAction & Omit<PayloadOf<"work.delivered">, "branch">;
export type SubmitIntentOptions = {
  task_id: TaskId;
  actor: string;
  item: string;
  epoch?: number;
  head_sha?: Sha;
} & Pick<PayloadOf<"work.submitted">, "method" | "state" | "pr_url" | "pr_number">;
export type FailIntentOptions = AgentAction & PayloadOf<"work.failed">;
export type CheckpointIntentOptions = AgentAction & PayloadOf<"checkpoint.recorded">;

/** Bound each duty tick to the remaining slots across all tasks (ARCHITECTURE §6.1, D16/F15). */
export function claimCandidates(state: State, agent: AgentId): ClaimCandidate[] {
  const record = state.agents[agent];
  if (!record) return [];
  const remaining = Math.max(0, record.profile.max_parallel_items - activeLeaseCount(state, agent));
  return claimableItems(state, agent).slice(0, remaining);
}

export function claimIntent(options: ClaimIntentOptions): Intent {
  const { task_id, actor, item, attempt_id } = options;
  return (state) => {
    const task = state.tasks[task_id];
    const candidate = task?.items[item];
    const agent = state.agents[actor];
    if (
      task?.status !== "executing" ||
      task.barrier !== null ||
      !candidate ||
      candidate.status !== "ready" ||
      candidate.assignee !== actor ||
      !agent ||
      actor === "human" ||
      activeLeaseCount(state, actor) >= agent.profile.max_parallel_items ||
      candidate.attempts_this_plan > task.budgets.item_retries ||
      task.active_plan_version === null ||
      task.active_plan_version !== task.current_plan_version
    )
      return null;
    const plan = task.plans[String(task.active_plan_version)];
    if (!plan) return null;
    const epoch = task.epochs[item] ?? 0;
    return draft(
      "lease.claimed",
      task_id,
      actor,
      { item, attempt_id, branch: workBranch(task_id, item, epoch + 1) },
      {
        task_rev: task.rev,
        plan_version: task.active_plan_version,
        plan_hash: plan.plan_hash,
        item,
        expected_epoch: epoch,
      },
    );
  };
}

function heldTask(
  state: State,
  action: AgentAction & { item: string; epoch: number },
  statuses: readonly TaskState["status"][],
): TaskState | null {
  const task = state.tasks[action.task_id];
  const lease = task?.items[action.item]?.lease;
  if (
    !task ||
    !statuses.includes(task.status) ||
    action.actor === "human" ||
    !lease ||
    lease.holder !== action.actor ||
    lease.epoch !== action.epoch
  )
    return null;
  return task;
}

export function releaseIntent(options: ReleaseIntentOptions): Intent {
  const action = structuredClone(options);
  return (state) => {
    // Interruption must still allow release/failure to settle a barrier (ARCHITECTURE §5.5).
    const task = heldTask(state, action, ["executing", "interrupting"]);
    if (!task) return null;
    return draft(
      "lease.released",
      action.task_id,
      action.actor,
      { item: action.item, epoch: action.epoch, reason: action.reason },
      { task_rev: task.rev, item: action.item },
    );
  };
}

export function revokeIntent(options: RevokeIntentOptions): Intent {
  const { task_id, item, epoch, reason } = options;
  return (state) => {
    const task = state.tasks[task_id];
    if (
      !task ||
      !["executing", "interrupting", "escalated"].includes(task.status) ||
      task.items[item]?.lease?.epoch !== epoch
    )
      return null;
    // MVP revocations are always human-signed; heartbeat evidence is reserved for V1 (§6.4).
    return draft(
      "lease.revoked",
      task_id,
      "human",
      { item, epoch, reason, observed_hb: null },
      { task_rev: task.rev, item },
    );
  };
}

export function deliverIntent(options: DeliverIntentOptions): Intent {
  const action = structuredClone(options);
  return (state) => {
    const task = heldTask(state, action, ["executing"]);
    const lease = task?.items[action.item]?.lease;
    if (!task || !lease || lease.interrupt !== null) return null;
    return draft(
      "work.delivered",
      action.task_id,
      action.actor,
      {
        item: action.item,
        epoch: action.epoch,
        branch: lease.branch,
        head_sha: action.head_sha,
        submit: structuredClone(action.submit),
        check_runs: structuredClone(action.check_runs),
      },
      { task_rev: task.rev, item: action.item },
    );
  };
}

export function submitIntent(options: SubmitIntentOptions): Intent {
  const action = structuredClone(options);
  return (state) => {
    const task = state.tasks[action.task_id];
    const item = task?.items[action.item];
    const delivery = item?.delivered;
    if (
      !task ||
      !["executing", "delivered", "escalated"].includes(task.status) ||
      item?.status !== "delivered" ||
      !delivery ||
      delivery.submit.state !== "pending" ||
      item.submission ||
      (action.epoch !== undefined && action.epoch !== delivery.epoch) ||
      (action.head_sha !== undefined && action.head_sha !== delivery.head_sha)
    )
      return null;
    const payload = WorkSubmittedPayload.safeParse({
      item: action.item,
      epoch: delivery.epoch,
      head_sha: delivery.head_sha,
      method: action.method,
      state: action.state,
      ...(action.pr_url === undefined ? {} : { pr_url: action.pr_url }),
      ...(action.pr_number === undefined ? {} : { pr_number: action.pr_number }),
    });
    if (!payload.success) return null;
    return draft("work.submitted", action.task_id, action.actor, payload.data, {
      task_rev: task.rev,
      item: action.item,
    });
  };
}

export function failIntent(options: FailIntentOptions): Intent {
  const action = structuredClone(options);
  return (state) => {
    const task = heldTask(state, action, ["executing", "interrupting"]);
    if (!task) return null;
    return draft(
      "work.failed",
      action.task_id,
      action.actor,
      { item: action.item, epoch: action.epoch, class: action.class, detail: action.detail },
      { task_rev: task.rev, item: action.item },
    );
  };
}

export function checkpointIntent(options: CheckpointIntentOptions): Intent {
  const action = structuredClone(options);
  return (state) => {
    const task = heldTask(state, action, ["executing", "interrupting", "replanning", "escalated"]);
    if (
      !task ||
      action.snapshot.item !== action.item ||
      action.snapshot.epoch !== action.epoch ||
      (action.barrier_id !== null && action.barrier_id !== task.barrier?.id)
    )
      return null;
    return draft(
      "checkpoint.recorded",
      action.task_id,
      action.actor,
      {
        item: action.item,
        epoch: action.epoch,
        barrier_id: action.barrier_id,
        snapshot: structuredClone(action.snapshot),
      },
      { task_rev: task.rev, item: action.item },
    );
  };
}
