import type { AgentId, BarrierId, ItemId, Sha, TaskId } from "../ids.js";
import { workBranch } from "../ids.js";
import { isSettled } from "./handlers/barrier.js";
import { activeLeaseCount } from "./handlers/lease.js";
import type { AgentRecord, Barrier, ItemState, State, TaskState } from "./state.js";

/**
 * Pure projections of reducer state for daemon duties and `skep status --machine`
 * (ARCHITECTURE §5.6). They re-read handler predicates (`activeLeaseCount`, `isSettled`)
 * instead of re-implementing lease or barrier rules (D16). No I/O, no clocks, no mutation.
 */

export interface ClaimCandidate {
  task_id: TaskId;
  item: ItemId;
  expected_epoch: number;
  plan_version: number;
  plan_hash: string;
  /** Branch the claim must name: `workBranch(task, item, epoch + 1)` (ARCHITECTURE §6.1). */
  branch: string;
}

export interface HeldLease {
  task_id: TaskId;
  item: ItemId;
  epoch: number;
  branch: string;
  interrupt: BarrierId | null;
  /** Item status `interrupted`: parked, so it does not count toward max_parallel (D16). */
  parked: boolean;
}

export interface PendingReview {
  task_id: TaskId;
  plan_version: number;
  plan_hash: string;
}

export interface BarrierStatus {
  id: BarrierId;
  /** True while `closed_seq` is still null. */
  open: boolean;
  awaiting: ItemId[];
  /** Awaited items settled by checkpoint or a cleared lease (`isSettled`, §5.5). */
  settled: ItemId[];
  /** Awaited items that have neither checkpointed nor released their lease. */
  missing: ItemId[];
  escalate: boolean;
  request_count: number;
}

export interface StatusAgent {
  id: AgentId;
  device: string;
  agent_cli: AgentRecord["profile"]["agent_cli"];
  cli_version: string;
  max_parallel_items: number;
}

export interface StatusItem {
  id: ItemId;
  status: ItemState["status"];
  assignee: AgentId;
  epoch: number | null;
  holder: AgentId | null;
  parked: boolean;
}

export interface StatusTask {
  task_id: TaskId;
  status: TaskState["status"];
  mode: TaskState["mode"];
  owner: AgentId;
  owner_gen: number;
  /** Latest proposed plan version, or null before the first proposal. */
  current_plan_version: number | null;
  /** Approved (or owner-locked) plan version, or null before activation. */
  active_plan_version: number | null;
  items: StatusItem[];
  barrier: BarrierStatus | null;
  /** Includes `verification_failed` (D14); the reason is what `skep status` must show. */
  escalation: { reason: string; seq: number } | null;
  verified: { top_of_stack_sha: Sha; passed: boolean; seq: number } | null;
  replan_count: number;
  replan_budget: number;
  review_rounds: number;
  review_round_budget: number;
}

/**
 * Stable JSON for `skep status --machine` (ARCHITECTURE §5.6, §12). Arrays are sorted so two
 * replays of the same log stringify identically. No provider name, config, hash or credential
 * appears here (D19): agents carry only `agent_cli` + `cli_version`.
 */
export interface StatusView {
  seq: number;
  tip: Sha;
  agents: StatusAgent[];
  tasks: StatusTask[];
}

function byTaskThenItem(
  a: { task_id: string; item: string },
  b: { task_id: string; item: string },
): number {
  return a.task_id < b.task_id
    ? -1
    : a.task_id > b.task_id
      ? 1
      : a.item < b.item
        ? -1
        : a.item > b.item
          ? 1
          : 0;
}

function stackIndex(task: TaskState, item: ItemId): number {
  const order = task.plans[String(task.active_plan_version)]?.plan.stack_order;
  const index = order?.indexOf(item) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Items `agent` may claim right now (ARCHITECTURE §6.1). An unregistered agent, or one already at
 * `max_parallel_items` active leases, gets nothing — the same conditions `lease.claimed` rejects
 * with `unknown_agent` / `max_parallel`.
 */
export function claimableItems(state: State, agent: AgentId): ClaimCandidate[] {
  const record = state.agents[agent];
  if (!record) return [];
  // D16: count only items still `leased`; a parked (`interrupted`) lease must not hide work.
  if (activeLeaseCount(state, agent) >= record.profile.max_parallel_items) return [];

  const candidates: { candidate: ClaimCandidate; stack: number }[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "executing" || task.barrier !== null || task.active_plan_version === null)
      continue;
    const plan = task.plans[String(task.active_plan_version)];
    if (!plan) continue;
    for (const item of Object.values(task.items)) {
      if (item.status !== "ready" || item.assignee !== agent) continue;
      // `lease.claimed` rejects once attempts exceed the budget (`retry_budget`).
      if (item.attempts_this_plan > task.budgets.item_retries) continue;
      const epoch = task.epochs[item.id] ?? 0;
      candidates.push({
        stack: stackIndex(task, item.id),
        candidate: {
          task_id: task.task_id,
          item: item.id,
          expected_epoch: epoch,
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
          branch: workBranch(task.task_id, item.id, epoch + 1),
        },
      });
    }
  }
  candidates.sort((a, b) => {
    if (a.candidate.task_id !== b.candidate.task_id)
      return a.candidate.task_id < b.candidate.task_id ? -1 : 1;
    return a.stack - b.stack;
  });
  return candidates.map((entry) => entry.candidate);
}

/** Leases still held by `agent`, with parked (`interrupted`) ones marked separately (D16). */
export function leasesHeldBy(state: State, agent: AgentId): HeldLease[] {
  const held: HeldLease[] = [];
  for (const task of Object.values(state.tasks)) {
    for (const item of Object.values(task.items)) {
      const lease = item.lease;
      if (!lease || lease.holder !== agent) continue;
      held.push({
        task_id: task.task_id,
        item: item.id,
        epoch: lease.epoch,
        branch: lease.branch,
        interrupt: lease.interrupt,
        parked: item.status === "interrupted",
      });
    }
  }
  held.sort(byTaskThenItem);
  return held;
}

export function isOwner(state: State, taskId: TaskId, agent: AgentId): boolean {
  return state.tasks[taskId]?.owner === agent;
}

/**
 * Current plans in `reviewing` that name `agent` as a reviewer and have no review from them yet
 * (ARCHITECTURE §5.5 `review.submitted`).
 */
export function pendingReviews(state: State, agent: AgentId): PendingReview[] {
  const pending: PendingReview[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "reviewing" || task.current_plan_version === null) continue;
    const plan = task.plans[String(task.current_plan_version)];
    if (!plan) continue;
    if (!plan.reviewers.includes(agent) || plan.reviews[agent]) continue;
    pending.push({
      task_id: task.task_id,
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
    });
  }
  pending.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  return pending;
}

/** Barrier projection for one task, or null when the task has none (or does not exist). */
export function barrierStatus(state: State, taskId: TaskId): BarrierStatus | null {
  const barrier = state.tasks[taskId]?.barrier;
  if (!barrier) return null;
  return projectBarrier(state.tasks[taskId] as TaskState, barrier);
}

function projectBarrier(task: TaskState, barrier: Barrier): BarrierStatus {
  const awaiting = [...barrier.awaiting].sort();
  const settled = awaiting.filter((id) => isSettled(task, id));
  const settledSet = new Set(settled);
  return {
    id: barrier.id,
    open: barrier.closed_seq === null,
    awaiting,
    settled,
    missing: awaiting.filter((id) => !settledSet.has(id)),
    escalate: barrier.escalate,
    request_count: barrier.requests.length,
  };
}

function projectItem(task: TaskState, item: ItemState): StatusItem {
  return {
    id: item.id,
    status: item.status,
    assignee: item.assignee,
    epoch: item.lease?.epoch ?? task.epochs[item.id] ?? null,
    holder: item.lease?.holder ?? null,
    parked: item.status === "interrupted" && item.lease !== null,
  };
}

function projectTask(task: TaskState): StatusTask {
  const order =
    task.plans[String(task.active_plan_version ?? task.current_plan_version)]?.plan.stack_order;
  const rank = new Map((order ?? []).map((id, index) => [id, index]));
  const items = Object.values(task.items)
    .map((item) => projectItem(task, item))
    .sort((a, b) => {
      const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return {
    task_id: task.task_id,
    status: task.status,
    mode: task.mode,
    owner: task.owner,
    owner_gen: task.owner_gen,
    current_plan_version: task.current_plan_version,
    active_plan_version: task.active_plan_version,
    items,
    barrier: task.barrier ? projectBarrier(task, task.barrier) : null,
    escalation: task.escalation
      ? { reason: task.escalation.reason, seq: task.escalation.seq }
      : null,
    verified: task.verified
      ? {
          top_of_stack_sha: task.verified.top_of_stack_sha,
          passed: task.verified.passed,
          seq: task.verified.seq,
        }
      : null,
    replan_count: task.replan_count,
    replan_budget: task.budgets.replans,
    review_rounds: task.review_rounds,
    review_round_budget: task.budgets.review_rounds,
  };
}

export function statusView(state: State): StatusView {
  const agents = Object.values(state.agents)
    .map((agent) => ({
      id: agent.agent,
      device: agent.device,
      agent_cli: agent.profile.agent_cli,
      cli_version: agent.profile.cli_version,
      max_parallel_items: agent.profile.max_parallel_items,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tasks = Object.values(state.tasks)
    .map(projectTask)
    .sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  return { seq: state.seq, tip: state.tip, agents, tasks };
}
