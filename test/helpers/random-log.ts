import { createHash } from "node:crypto";
import { contentHash } from "../../src/core/canonical.js";
import { eventPath, workBranch } from "../../src/core/ids.js";
import type { LogEntry, SignatureCheck } from "../../src/core/log.js";
import { applyEntry, replay } from "../../src/core/reducer/replay.js";
import type { ItemState, State, TaskState } from "../../src/core/reducer/state.js";
import { type Budgets, DEFAULT_BUDGETS } from "../../src/core/schemas/common.js";
import {
  EVENT_SCHEMA,
  type PayloadOf,
  type Pre,
  type SkepEvent,
  serializeEvent,
} from "../../src/core/schemas/events.js";
import type { Evidence } from "../../src/core/schemas/evidence.js";
import type { Genesis } from "../../src/core/schemas/genesis.js";
import type { Plan, PlanItem } from "../../src/core/schemas/plan.js";
import { Rng } from "../../src/sim/rng.js";

/**
 * Seeded random blackboard logs for the reducer property tests (SK-304, ARCHITECTURE §14).
 *
 * The well-formed stream reads the reducer's own state after every entry and only appends an
 * event that state permits, so it reaches the paths the invariants exist for: a failed
 * `task.verified` followed by `human.decided` (D14), and a replan whose replacement plan carries
 * every item over (D7/D15). It deliberately does not re-implement the handlers — each choice is
 * checked by replaying, and an entry the reducer rejects is discarded and retried.
 *
 * Forged entries (bad signature, unknown key, unsigned, unauthorized actor, stale tip) are
 * appended unconditionally and must be no-ops. SK-305 may import this module but must not
 * modify it; golden fixtures pin their own logs.
 */

export interface RandomLogOptions {
  /** Well-formed entries to land before stopping. Forged entries do not count. Default 24. */
  events?: number;
  /** Probability that the next appended entry is forged rather than well-formed. Default 0.15. */
  forgedRate?: number;
  /** How many tasks the log may create. Default 2. */
  tasks?: number;
  /** Agents registered before the first task. Default mac.coding (2) and vps.coding (1). */
  agents?: readonly AgentSpec[];
}

export interface AgentSpec {
  id: string;
  maxParallel: number;
}

export interface RandomLog {
  seed: number | string;
  entries: LogEntry[];
  /** Seq of every forged entry. */
  forgedSeqs: number[];
}

const AGENTS: readonly AgentSpec[] = [
  { id: "mac.coding", maxParallel: 2 },
  { id: "vps.coding", maxParallel: 1 },
];

const REPO = "git@example.invalid:example/app.git";
const BRANCH = "main";
const AT = "2026-10-05T09:00:00Z";
const BASE = createHash("sha1").update("random-log-base").digest("hex");

/**
 * One log, fully determined by `seed`: every choice comes from {@link Rng} and the sha/event ids
 * are derived from the stream position, so drawing randomness for a sha can never perturb a choice.
 */
export function randomLog(seed: number | string, opts: RandomLogOptions = {}): RandomLog {
  const rng = new Rng(seed);
  const target = opts.events ?? 24;
  const forgedRate = opts.forgedRate ?? 0.15;
  const taskCap = opts.tasks ?? 2;
  const agents = opts.agents ?? AGENTS;
  const stream = new Stream(rng);
  for (const agent of agents) stream.register(agent);

  let state = replay(stream.entries);
  const forgedSeqs: number[] = [];
  let landed = 0;
  // A seed that runs out of legal moves stops early rather than spinning.
  for (let attempt = 0; attempt < target * 6 + 8 && landed < target; attempt++) {
    if (rng.chance(forgedRate)) {
      stream.forge(state, agents);
      forgedSeqs.push(stream.entries.length - 1);
      state = applyEntry(state, last(stream));
      continue;
    }
    const event = pickEvent(rng, state, agents, taskCap);
    if (!event) break;
    stream.append(event);
    const next = applyEntry(state, last(stream));
    if (next.outcomes.at(-1)?.outcome !== "accepted") {
      // The choice was legal as far as the generator could see, but the reducer disagreed.
      // Drop it and keep the log valid; the disagreement itself is reported by the property test.
      stream.entries.pop();
      continue;
    }
    state = next;
    landed += 1;
  }
  return { seed, entries: stream.entries, forgedSeqs };
}

interface Choice {
  weight: number;
  build: () => SkepEvent | null;
}

function pickEvent(
  rng: Rng,
  state: State,
  agents: readonly AgentSpec[],
  taskCap: number,
): SkepEvent | null {
  const choices: Choice[] = [];
  const tasks = Object.values(state.tasks);
  if (tasks.length < taskCap) {
    choices.push({ weight: 3, build: () => taskCreated(rng, state, agents) });
  }
  for (const task of tasks) {
    for (const choice of choicesFor(rng, state, task)) choices.push(choice);
  }
  const bag = choices.filter((choice) => choice.weight > 0);
  if (bag.length === 0) return null;
  const total = bag.reduce((sum, choice) => sum + choice.weight, 0);
  let roll = rng.next() * total;
  for (const choice of bag) {
    roll -= choice.weight;
    if (roll < 0) return choice.build();
  }
  return bag[bag.length - 1]?.build() ?? null;
}

function choicesFor(rng: Rng, state: State, task: TaskState): Choice[] {
  const out: Choice[] = [];
  const plan = task.plans[String(task.current_plan_version)];
  switch (task.status) {
    case "planning":
    case "replanning":
      out.push({ weight: 4, build: () => planProposed(rng, state, task) });
      break;
    case "reviewing":
      out.push({ weight: 2, build: () => reviewSubmitted(rng, state, task, "approve") });
      // A block with evidence counts as a failed review round once the next plan supersedes it.
      out.push({ weight: 2, build: () => reviewSubmitted(rng, state, task, "block") });
      if (plan?.reviewers.every((reviewer) => plan.reviews[reviewer])) {
        out.push({ weight: 3, build: () => planLocked(task) });
      }
      break;
    case "awaiting_approval":
      out.push({ weight: 3, build: () => planDecision(task, "plan.approved") });
      // Repeated rejections are what exhausts the review-round budget (D20).
      out.push({ weight: 2, build: () => planDecision(task, "plan.rejected") });
      break;
    case "executing":
      for (const item of Object.values(task.items)) {
        if (item.status === "ready")
          out.push({ weight: 4, build: () => leaseClaimed(state, task, item) });
        if (item.status === "leased" && item.lease) {
          out.push({ weight: 4, build: () => workDelivered(state, task, item) });
          out.push({ weight: 1, build: () => workFailed(rng, task, item) });
          out.push({ weight: 1, build: () => leaseReleased(task, item) });
        }
      }
      out.push({ weight: 2, build: () => replanRequested(state, task) });
      out.push({ weight: 1, build: () => taskCancelled(task) });
      break;
    case "interrupting":
      for (const item of Object.values(task.items)) {
        if (item.status === "leased" && item.lease) {
          out.push({ weight: 4, build: () => checkpoint(state, task, item) });
        }
      }
      if (task.barrier) out.push({ weight: 2, build: () => barrierClosed(task) });
      out.push({ weight: 1, build: () => replanRequested(state, task) });
      break;
    case "delivered":
      // Both outcomes matter: passed keeps the task delivered, failed escalates (D14).
      out.push({ weight: 3, build: () => taskVerified(task, true) });
      out.push({ weight: 3, build: () => taskVerified(task, false) });
      out.push({ weight: 2, build: () => itemMerged(task) });
      break;
    case "escalated":
      out.push({ weight: 3, build: () => humanDecided(state, task, "resume_with_plan") });
      out.push({ weight: 3, build: () => humanDecided(state, task, "replan") });
      out.push({ weight: 1, build: () => humanDecided(state, task, "cancel") });
      out.push({ weight: 1, build: () => humanDecided(state, task, "reassign_owner") });
      out.push({ weight: 2, build: () => itemMerged(task) });
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Event builders. Each reads the reducer state and fills the preconditions that state implies.
// ---------------------------------------------------------------------------------------------

function taskCreated(rng: Rng, state: State, agents: readonly AgentSpec[]): SkepEvent | null {
  const owner = rng.pick(agents);
  if (!state.agents[owner.id]) return null;
  const budgets: Budgets = {
    ...DEFAULT_BUDGETS,
    replans: rng.int(1, 2),
    review_rounds: rng.int(1, 3),
    item_retries: rng.int(0, 2),
  };
  return event("task.created", {
    task_id: taskId(Object.keys(state.tasks).length),
    actor: "human",
    payload: {
      title: "Ship the requested change",
      body: "Implement the change described by the human and cover it with the unit check.",
      repo: REPO,
      base_branch: BRANCH,
      mode: rng.chance(0.5) ? "team" : "solo",
      owner: owner.id,
      budgets,
      plan_approval: rng.chance(0.7) ? "human" : "owner",
    },
  });
}

function planProposed(rng: Rng, state: State, task: TaskState): SkepEvent | null {
  const version = (task.current_plan_version ?? 0) + 1;
  const carry =
    task.status === "replanning" && Object.keys(task.items).length > 0 && rng.chance(0.7);
  const plan = carry ? carriedPlan(task, version) : freshPlan(rng, state, task, version);
  if (!plan) return null;
  const reviewers = plan.mode === "solo" ? [] : peerReviewers(rng, state, task);
  if (plan.mode === "team" && reviewers.length === 0) return null;
  return event("plan.proposed", {
    task_id: task.task_id,
    actor: task.owner,
    pre: { task_rev: task.rev, owner_gen: task.owner_gen },
    payload: {
      version,
      parent_version: task.current_plan_version,
      plan,
      plan_hash: contentHash(plan),
      base_commit: plan.base.commit,
      reviewers,
    },
  });
}

function freshPlan(rng: Rng, state: State, task: TaskState, version: number): Plan | null {
  // D13: a team task only accepts a team plan; a solo task may upgrade.
  const registered = Object.keys(state.agents);
  if (registered.length === 0) return null;
  const mode: "solo" | "team" = task.mode === "team" || rng.chance(0.5) ? "team" : "solo";
  const count = mode === "solo" ? 1 : rng.int(2, Math.min(3, registered.length + 1));
  const items: PlanItem[] = [];
  for (let n = 0; n < count; n++) {
    const id = `W${n + 1}`;
    const assignee =
      mode === "solo" ? task.owner : (registered[n % registered.length] ?? task.owner);
    items.push(itemDef(id, assignee, n === 0 ? [] : [`W${n}`]));
  }
  return planDoc(task, version, mode, items);
}

/** Replacement plan that reproduces every item definition, so activation carries them all (D7/D15). */
function carriedPlan(task: TaskState, version: number): Plan | null {
  const previous = task.plans[String(task.active_plan_version)]?.plan;
  if (!previous || previous.items.length === 0) return null;
  const mode: "solo" | "team" = previous.items.length === 1 ? "solo" : "team";
  return planDoc(
    task,
    version,
    mode,
    previous.items.map((item) => structuredClone(item)),
  );
}

function planDoc(task: TaskState, version: number, mode: "solo" | "team", items: PlanItem[]): Plan {
  return {
    schema: "skep.plan/v1",
    task_id: task.task_id,
    version,
    parent_version: version === 1 ? null : version - 1,
    base: { repo: REPO, branch: BRANCH, commit: BASE },
    mode,
    summary: `Plan version ${version} for ${task.task_id}.`,
    items,
    stack_order: items.map((item) => item.id),
    changes_from_parent: version === 1 ? null : "Carry completed items forward unchanged.",
  };
}

function itemDef(id: string, assignee: string, dependsOn: string[]): PlanItem {
  return {
    id,
    title: `Implement ${id}`,
    role: "coding",
    assignee,
    depends_on: dependsOn,
    touches: [`src/${id.toLowerCase()}/`],
    risk: "normal",
    acceptance: [{ kind: "check", name: "unit" }],
  };
}

function peerReviewers(rng: Rng, state: State, task: TaskState): string[] {
  const peers = Object.keys(state.agents).filter((agent) => agent !== task.owner);
  return peers.length === 0 ? [] : [rng.pick(peers)];
}

function reviewSubmitted(
  rng: Rng,
  state: State,
  task: TaskState,
  verdict: "approve" | "block",
): SkepEvent | null {
  const plan = task.plans[String(task.current_plan_version)];
  if (!plan) return null;
  const pending = plan.reviewers.filter((reviewer) => !plan.reviews[reviewer]);
  const reviewer = pending[0] ?? plan.reviewers[0];
  if (!reviewer) return null;
  void rng;
  return event("review.submitted", {
    task_id: task.task_id,
    actor: reviewer,
    pre: { task_rev: task.rev, plan_version: plan.version, plan_hash: plan.plan_hash },
    payload: {
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
      verdict,
      blockers:
        verdict === "block"
          ? [
              {
                id: "B1",
                claim: "The acceptance check does not cover the changed path.",
                evidence: [evidence(state)],
              },
            ]
          : [],
      suggestions: [],
    },
  });
}

function planLocked(task: TaskState): SkepEvent | null {
  const plan = task.plans[String(task.current_plan_version)];
  if (!plan) return null;
  const missing = plan.reviewers.filter((reviewer) => !plan.reviews[reviewer]);
  return event("plan.locked", {
    task_id: task.task_id,
    actor: task.owner,
    pre: {
      task_rev: task.rev,
      owner_gen: task.owner_gen,
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
    },
    payload: {
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
      overrides: [],
      missing_reviews: [...missing].sort(),
    },
  });
}

function planDecision(task: TaskState, type: "plan.approved" | "plan.rejected"): SkepEvent | null {
  const plan = task.plans[String(task.current_plan_version)];
  if (!plan?.locked) return null;
  return event(type, {
    task_id: task.task_id,
    actor: "human",
    pre: { task_rev: task.rev, plan_version: plan.version, plan_hash: plan.plan_hash },
    payload: {
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
      note: "Reviewed by the human.",
    },
  });
}

function leaseClaimed(state: State, task: TaskState, item: ItemState): SkepEvent | null {
  if (task.barrier !== null) return null;
  const plan = task.plans[String(task.active_plan_version)];
  if (!plan) return null;
  const agent = state.agents[item.assignee];
  if (!agent) return null;
  const held = leasesOf(state, item.assignee);
  if (held >= agent.profile.max_parallel_items) return null;
  const epoch = task.epochs[item.id] ?? 0;
  return event("lease.claimed", {
    task_id: task.task_id,
    actor: item.assignee,
    pre: {
      task_rev: task.rev,
      plan_version: plan.version,
      plan_hash: plan.plan_hash,
      item: item.id,
      expected_epoch: epoch,
    },
    payload: {
      item: item.id,
      attempt_id: attemptId(state),
      branch: workBranch(task.task_id, item.id, epoch + 1),
    },
  });
}

function leasesOf(state: State, agent: string): number {
  let count = 0;
  for (const task of Object.values(state.tasks)) {
    for (const item of Object.values(task.items)) {
      if (item.status === "leased" && item.lease?.holder === agent) count += 1;
    }
  }
  return count;
}

function workDelivered(state: State, task: TaskState, item: ItemState): SkepEvent | null {
  const lease = item.lease;
  if (!lease || lease.interrupt !== null) return null;
  const pr = nextPr(state);
  const head = sha(`head-${task.task_id}-${item.id}-${lease.epoch}`);
  return event("work.delivered", {
    task_id: task.task_id,
    actor: lease.holder,
    pre: { task_rev: task.rev, item: item.id },
    payload: {
      item: item.id,
      epoch: lease.epoch,
      branch: lease.branch,
      head_sha: head,
      pr_url: `https://example.com/example/app/pull/${pr}`,
      pr_number: pr,
      check_runs: [checkRun(head)],
    },
  });
}

function workFailed(rng: Rng, task: TaskState, item: ItemState): SkepEvent | null {
  const lease = item.lease;
  if (!lease) return null;
  const fatal = rng.chance(0.4);
  return event("work.failed", {
    task_id: task.task_id,
    actor: lease.holder,
    pre: { task_rev: task.rev, item: item.id },
    payload: {
      item: item.id,
      epoch: lease.epoch,
      class: fatal ? "budget_exceeded" : "checks_failed",
      detail: fatal ? "The wall-clock budget was exhausted." : "The unit check failed.",
    },
  });
}

function leaseReleased(task: TaskState, item: ItemState): SkepEvent | null {
  const lease = item.lease;
  if (!lease) return null;
  return event("lease.released", {
    task_id: task.task_id,
    actor: lease.holder,
    pre: { task_rev: task.rev, item: item.id },
    payload: { item: item.id, epoch: lease.epoch, reason: "Yielding the lease." },
  });
}

function replanRequested(state: State, task: TaskState): SkepEvent | null {
  const leased = Object.values(task.items).find((item) => item.status === "leased");
  return event("replan.requested", {
    task_id: task.task_id,
    actor: task.owner,
    pre: { task_rev: task.rev },
    payload: {
      summary: "The plan no longer matches what the code needs.",
      evidence: [evidence(state)],
      item: leased?.id ?? Object.values(task.items)[0]?.id ?? null,
    },
  });
}

function checkpoint(state: State, task: TaskState, item: ItemState): SkepEvent | null {
  const lease = item.lease;
  const barrier = task.barrier;
  if (!lease || !barrier) return null;
  const head = sha(`ckpt-${state.seq}-${item.id}`);
  return event("checkpoint.recorded", {
    task_id: task.task_id,
    actor: lease.holder,
    pre: { task_rev: task.rev, item: item.id },
    payload: {
      item: item.id,
      epoch: lease.epoch,
      barrier_id: barrier.id,
      snapshot: {
        schema: "skep.snapshot/v1",
        item: item.id,
        epoch: lease.epoch,
        attempt_id: lease.attempt_id,
        branch: lease.branch,
        base_sha: BASE,
        head_sha: head,
        pushed: true,
        invocation_state: "interrupted",
        diffstat: { files: 1, insertions: 1, deletions: 0 },
        files_changed: [`src/${item.id.toLowerCase()}/`],
        check_runs: [],
        agent_note: null,
      },
    },
  });
}

function barrierClosed(task: TaskState): SkepEvent | null {
  const barrier = task.barrier;
  if (!barrier || barrier.closed_seq !== null) return null;
  const missing = barrier.awaiting.filter((id) => {
    const item = task.items[id];
    return item?.lease !== null && !barrier.checkpointed.includes(id);
  });
  return event("barrier.closed", {
    task_id: task.task_id,
    actor: task.owner,
    pre: { task_rev: task.rev },
    payload: { barrier_id: barrier.id, missing },
  });
}

function taskVerified(task: TaskState, passed: boolean): SkepEvent | null {
  const plan = task.plans[String(task.active_plan_version)];
  const top = plan?.plan.stack_order.at(-1);
  const head = top ? task.items[top]?.delivered?.head_sha : undefined;
  if (!plan || !head) return null;
  return event("task.verified", {
    task_id: task.task_id,
    actor: task.owner,
    pre: { task_rev: task.rev, owner_gen: task.owner_gen, plan_hash: plan.plan_hash },
    payload: { top_of_stack_sha: head, check_runs: [checkRun(head)], passed },
  });
}

function itemMerged(task: TaskState): SkepEvent | null {
  const item = Object.values(task.items).find(
    (candidate) => candidate.status === "delivered" && candidate.delivered,
  );
  if (!item?.delivered) return null;
  return event("item.merged", {
    task_id: task.task_id,
    actor: "human",
    pre: { task_rev: task.rev, item: item.id },
    payload: {
      item: item.id,
      pr_number: item.delivered.pr_number,
      merge_sha: sha(`merge-${task.task_id}-${item.id}`),
    },
  });
}

function humanDecided(
  state: State,
  task: TaskState,
  decision: "resume_with_plan" | "replan" | "cancel" | "reassign_owner",
): SkepEvent | null {
  if (decision === "resume_with_plan" && task.active_plan_version === null) return null;
  const successor = Object.keys(state.agents).find((agent) => agent !== task.owner);
  if (decision === "reassign_owner" && !successor) return null;
  return event("human.decided", {
    task_id: task.task_id,
    actor: "human",
    pre: { task_rev: task.rev },
    payload:
      decision === "reassign_owner"
        ? { decision, new_owner: successor, note: "Handing the task to another owner." }
        : { decision, note: "Decided after escalation." },
  });
}

function taskCancelled(task: TaskState): SkepEvent {
  return event("task.cancelled", {
    task_id: task.task_id,
    actor: "human",
    pre: { task_rev: task.rev },
    payload: { reason: "The task is no longer needed." },
  });
}

// ---------------------------------------------------------------------------------------------
// Forgeries. Each is a real log entry the reducer must treat as a no-op.
// ---------------------------------------------------------------------------------------------

function forge(stream: Stream, state: State, agents: readonly AgentSpec[]): void {
  const kind = stream.rng.int(0, 4);
  const task = Object.values(state.tasks)[0];
  if (kind === 0) {
    stream.appendRaw(cancelEvent(stream, task), { status: "missing" });
  } else if (kind === 1) {
    stream.appendRaw(cancelEvent(stream, task), { status: "bad", detail: "forged signature" });
  } else if (kind === 2) {
    stream.appendRaw(cancelEvent(stream, task), {
      status: "unknown_key",
      detail: "not in allowed_signers",
    });
  } else if (kind === 3) {
    // A daemon principal signing an event whose actor is the human: unauthorized (ARCHITECTURE §5.4).
    const device = agents[0]?.id.split(".")[0] ?? "mac";
    stream.appendRaw(cancelEvent(stream, task), { status: "good", principal: `daemon:${device}` });
  } else {
    stream.appendRaw(cancelEvent(stream, task, sha("stale-tip")), {
      status: "good",
      principal: "human",
    });
  }
}

function cancelEvent(stream: Stream, task: TaskState | undefined, observedTip?: string): SkepEvent {
  return event("task.cancelled", {
    task_id: task?.task_id ?? taskId(0),
    actor: "human",
    observedTip: observedTip ?? stream.tip,
    pre: { task_rev: task?.rev ?? 0 },
    payload: { reason: "Forged cancellation." },
    eventId: stream.eventId(),
  });
}

// ---------------------------------------------------------------------------------------------
// Stream: genesis plus entries, with ids derived from the position so the log is a pure function
// of the seed.
// ---------------------------------------------------------------------------------------------

interface Built<T extends keyof PayloadMap> {
  type: T;
  task_id: string | null;
  actor: string;
  payload: PayloadMap[T];
  pre?: Pre;
  observedTip?: string;
  eventId?: string;
}

interface PayloadMap {
  "agent.registered": PayloadOf<"agent.registered">;
  "task.created": PayloadOf<"task.created">;
  "task.cancelled": PayloadOf<"task.cancelled">;
  "plan.proposed": PayloadOf<"plan.proposed">;
  "review.submitted": PayloadOf<"review.submitted">;
  "plan.locked": PayloadOf<"plan.locked">;
  "plan.approved": PayloadOf<"plan.approved">;
  "plan.rejected": PayloadOf<"plan.rejected">;
  "lease.claimed": PayloadOf<"lease.claimed">;
  "lease.released": PayloadOf<"lease.released">;
  "work.delivered": PayloadOf<"work.delivered">;
  "work.failed": PayloadOf<"work.failed">;
  "replan.requested": PayloadOf<"replan.requested">;
  "checkpoint.recorded": PayloadOf<"checkpoint.recorded">;
  "barrier.closed": PayloadOf<"barrier.closed">;
  "item.merged": PayloadOf<"item.merged">;
  "task.verified": PayloadOf<"task.verified">;
  "human.decided": PayloadOf<"human.decided">;
}

function event<T extends keyof PayloadMap>(type: T, built: Omit<Built<T>, "type">): SkepEvent {
  const seq = built.eventId ?? "pending";
  return {
    schema: EVENT_SCHEMA,
    event_id: built.eventId ?? eventIdFor(seq),
    type,
    task_id: built.task_id,
    actor: built.actor,
    observed_tip: built.observedTip ?? "",
    pre: built.pre ?? {},
    created_at: AT,
    lang: "en",
    payload: built.payload,
  } as SkepEvent;
}

function eventIdFor(key: string): string {
  const hex = createHash("sha256").update(`evt:${key}`).digest("hex");
  return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class Stream {
  readonly entries: LogEntry[] = [];
  readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
    const genesis: Genesis = {
      schema: "skep.genesis/v1",
      protocol_version: 1,
      reducer_version: 1,
      blackboard_id: "bb_test0001",
      created_at: "2026-10-05T00:00:00Z",
    };
    this.entries.push({
      seq: 0,
      sha: sha("genesis"),
      parents: [],
      signature: { status: "good", principal: "human" },
      changes: [{ status: "A", path: "skep.json" }],
      added: { "skep.json": `${JSON.stringify(genesis, null, 2)}\n` },
    });
  }

  get tip(): string {
    return this.entries[this.entries.length - 1]?.sha ?? "";
  }

  register(agent: AgentSpec): void {
    this.append(
      event("agent.registered", {
        task_id: null,
        actor: agent.id,
        payload: {
          role: "coding",
          agent_cli: "codex",
          cli_version: "0.0.0-test",
          capabilities: ["typescript"],
          requires_local: [],
          max_parallel_items: agent.maxParallel,
        },
      }),
    );
  }

  append(raw: SkepEvent): void {
    const observed = raw.observed_tip === "" ? this.tip : raw.observed_tip;
    const eventId =
      raw.event_id === eventIdFor("pending")
        ? eventIdFor(String(this.entries.length))
        : raw.event_id;
    const filled = { ...raw, event_id: eventId, observed_tip: observed } as SkepEvent;
    const principal = raw.actor === "human" ? "human" : `daemon:${raw.actor.split(".")[0]}`;
    this.appendRaw(filled, { status: "good", principal });
  }

  appendRaw(ev: SkepEvent, signature: SignatureCheck): void {
    const path = eventPath(ev.task_id, ev.event_id);
    this.entries.push({
      seq: this.entries.length,
      sha: sha(`commit-${this.entries.length}`),
      parents: [this.tip],
      signature,
      changes: [{ status: "A", path }],
      added: { [path]: serializeEvent(ev) },
    });
  }

  forge(state: State, agents: readonly AgentSpec[]): void {
    forge(this, state, agents);
  }

  eventId(): string {
    return eventIdFor(String(this.entries.length));
  }
}

function last(stream: Stream): LogEntry {
  const entry = stream.entries[stream.entries.length - 1];
  if (!entry) throw new Error("random log has no entries");
  return entry;
}

function sha(label: string): string {
  return createHash("sha1").update(label).digest("hex");
}

function taskId(n: number): string {
  return `T-20261005-${n.toString(16).padStart(4, "0")}`;
}

function attemptId(state: State): string {
  return `att_${(state.seq + 1).toString(36).padStart(2, "0")}`;
}

function nextPr(state: State): number {
  let max = 0;
  for (const task of Object.values(state.tasks)) {
    for (const item of Object.values(task.items)) {
      if (item.delivered && item.delivered.pr_number > max) max = item.delivered.pr_number;
    }
  }
  return max + 1;
}

function evidence(state: State): Evidence {
  return {
    id: "ev_check_1",
    type: "check_run",
    run_id: "run-1",
    check: "unit",
    sha: sha(`evidence-${state.seq}`),
    exit: 1,
    log_sha256: "ab".repeat(32),
  };
}

function checkRun(head: string): PayloadOf<"work.delivered">["check_runs"][number] {
  return {
    run_id: "run-1",
    check: "unit",
    sha: head,
    exit: 0,
    duration_ms: 10,
    passed: 1,
    failed: 0,
    log_sha256: sha(`log-${head}`).padEnd(64, "0").slice(0, 64),
  };
}
