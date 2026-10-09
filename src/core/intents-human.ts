/**
 * Human-signed intents (ARCHITECTURE §5.4–§5.5, PRD §15.2).
 *
 * Each builder closes over what the human asked for and returns an {@link Intent}: a pure
 * function that re-derives the event draft from the state the publisher just replayed, or
 * `null` when that state can no longer accept the action. Returning `null` is what makes the
 * daemon path and the CLI fallback path behave identically (ARCHITECTURE §12) — the publisher
 * reports `dropped` instead of appending an event the reducer would reject.
 *
 * These are the only intents a human key may sign. Daemon duties live in `intents.ts` (SK-403)
 * and stay untouched.
 */

import type { AgentId, TaskId } from "./ids.js";
import { draft, type Intent } from "./intents.js";
import type { State, TaskState } from "./reducer/state.js";
import { DEFAULT_BUDGETS } from "./schemas/common.js";
import type { PayloadOf } from "./schemas/events.js";
import type { Evidence } from "./schemas/evidence.js";

const HUMAN = "human";

/** Statuses in which a human may still fence a lease (ARCHITECTURE §5.5 `lease.revoked`). */
const REVOCABLE = ["executing", "interrupting", "escalated"] as const;

/** Statuses in which a replan request opens or joins a barrier (ARCHITECTURE §5.5). */
const REPLANNABLE = ["executing", "interrupting", "replanning"] as const;

/**
 * What `skep task new` asks for. The task id, budgets and approval policy are re-derived here,
 * never taken from the human's text: budgets are the protocol defaults (PRD §9.9) and approval
 * is the human gate (PRD §9.4).
 */
export interface TaskCreateInput {
  title: string;
  body: string;
  repo: string;
  /** Branch the plan is cut from. Defaults to `main` when the human did not name one. */
  baseBranch?: string;
  mode: "solo" | "team";
  submit?: PayloadOf<"task.created">["submit"];
  /** Owning agent. When omitted, the single registered agent is used. */
  owner?: AgentId;
  /** Verbatim non-English source, kept for audit only (PRD §14). */
  originalText?: string;
  originalLang?: string;
}

/** The title is the first line of the body, clipped to the schema's short-text limit. */
export function titleFromBody(body: string): string {
  const line = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = line === "" ? "Task" : line;
  return title.length > 500 ? title.slice(0, 500) : title;
}

/**
 * `task.created`. `taskId` is minted once by the caller (PRD §10.2) so every write-loop retry
 * publishes the same task; this module stays pure and does not draw it. `null` when the chosen
 * owner is not a registered agent, or when no owner was named and the registry does not contain
 * exactly one.
 */
export function taskCreateIntent(input: TaskCreateInput, taskId: TaskId): Intent {
  return (state) => {
    const owner = resolveOwner(state, input.owner);
    if (owner === null) return null;
    return draft(
      "task.created",
      taskId,
      HUMAN,
      {
        title: input.title,
        body: input.body,
        repo: input.repo,
        base_branch: input.baseBranch ?? "main",
        mode: input.mode,
        submit: input.submit ?? "device",
        owner,
        budgets: { ...DEFAULT_BUDGETS },
        plan_approval: "human",
        ...(input.originalText === undefined ? {} : { original_text: input.originalText }),
        ...(input.originalLang === undefined ? {} : { original_lang: input.originalLang }),
      },
      {},
    );
  };
}

/** `task.cancelled` (any non-terminal status). `null` when the task is unknown or already over. */
export function taskCancelIntent(taskId: TaskId, reason: string): Intent {
  return (state) => {
    const task = openTask(state, taskId);
    if (!task) return null;
    return draft("task.cancelled", taskId, HUMAN, { reason }, { task_rev: task.rev });
  };
}

/**
 * `plan.approved` of the plan currently awaiting the human (ARCHITECTURE §5.5). `planHash`, when
 * the human passed one, must be the hash they saw — a plan that moved on since is `null`, not a
 * decision against a different plan.
 */
export function planApproveIntent(
  taskId: TaskId,
  opts?: { planHash?: string; note?: string },
): Intent {
  return planDecisionIntent("plan.approved", taskId, opts);
}

/** `plan.rejected`. Same pinning rules as {@link planApproveIntent}. */
export function planRejectIntent(
  taskId: TaskId,
  opts?: { planHash?: string; note?: string },
): Intent {
  return planDecisionIntent("plan.rejected", taskId, opts);
}

/**
 * `lease.revoked` (ARCHITECTURE §6.4). MVP revocations are human-signed and carry no heartbeat
 * evidence, so `observed_hb` is always null. `null` unless that exact epoch is still leased.
 */
export function leaseRevokeIntent(
  taskId: TaskId,
  item: string,
  epoch: number,
  reason?: string,
): Intent {
  return (state) => {
    const task = state.tasks[taskId];
    if (!task || !isOneOf(task.status, REVOCABLE)) return null;
    if (task.items[item]?.lease?.epoch !== epoch) return null;
    return draft(
      "lease.revoked",
      taskId,
      HUMAN,
      { item, epoch, reason: reason ?? "revoked by human", observed_hb: null },
      { task_rev: task.rev, item },
    );
  };
}

/** `human.decided` on an escalated task. `null` unless the task is `escalated`. */
export function humanDecideIntent(
  taskId: TaskId,
  decision: "resume_with_plan" | "replan" | "cancel" | "reassign_owner",
  opts?: { newOwner?: AgentId; note?: string },
): Intent {
  return (state) => {
    const task = state.tasks[taskId];
    if (task?.status !== "escalated") return null;
    if (decision === "reassign_owner" && opts?.newOwner === undefined) return null;
    return draft(
      "human.decided",
      taskId,
      HUMAN,
      {
        decision,
        ...(opts?.note === undefined ? {} : { note: opts.note }),
        ...(decision === "reassign_owner" && opts?.newOwner !== undefined
          ? { new_owner: opts.newOwner }
          : {}),
      },
      { task_rev: task.rev },
    );
  };
}

/**
 * Human `replan.requested` (PRD §9.7, §9.9). Evidence is optional for a human actor. `item` is
 * null when the request is about the task rather than one item. `null` when the task is not in a
 * status that can open or join a barrier, or when the named item is not part of it.
 */
export function replanRequestIntent(
  taskId: TaskId,
  summary: string,
  opts?: { evidence?: Evidence[]; item?: string | null },
): Intent {
  const evidence = opts?.evidence ?? [];
  const item = opts?.item ?? null;
  return (state) => {
    const task = state.tasks[taskId];
    if (!task || !isOneOf(task.status, REPLANNABLE)) return null;
    if (item !== null && !task.items[item]) return null;
    return draft(
      "replan.requested",
      taskId,
      HUMAN,
      { summary, evidence: structuredClone(evidence), item },
      { task_rev: task.rev },
    );
  };
}

function planDecisionIntent(
  type: "plan.approved" | "plan.rejected",
  taskId: TaskId,
  opts?: { planHash?: string; note?: string },
): Intent {
  return (state) => {
    const task = state.tasks[taskId];
    if (task?.status !== "awaiting_approval" || task.current_plan_version === null) return null;
    const plan = task.plans[String(task.current_plan_version)];
    // A decision names the locked plan the human was shown; an unlocked plan is not decidable.
    if (!plan || plan.locked === null) return null;
    if (opts?.planHash !== undefined && opts.planHash !== plan.plan_hash) return null;
    return draft(
      type,
      taskId,
      HUMAN,
      {
        plan_version: plan.version,
        plan_hash: plan.plan_hash,
        ...(opts?.note === undefined ? {} : { note: opts.note }),
      },
      { task_rev: task.rev, plan_version: plan.version, plan_hash: plan.plan_hash },
    );
  };
}

/** The named owner when registered, otherwise the only registered agent, otherwise none. */
function resolveOwner(state: State, requested: AgentId | undefined): AgentId | null {
  if (requested !== undefined) return state.agents[requested] ? requested : null;
  const agents = Object.keys(state.agents);
  return agents.length === 1 ? (agents[0] ?? null) : null;
}

/** A task a human action can still change: present and not `done` or `cancelled`. */
function openTask(state: State, taskId: TaskId): TaskState | null {
  const task = state.tasks[taskId];
  if (!task || task.status === "done" || task.status === "cancelled") return null;
  return task;
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}
