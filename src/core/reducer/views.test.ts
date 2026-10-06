import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  fakeSha,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  T2,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import { canonicalJson } from "../canonical.js";
import type { AgentId, ItemId, TaskId } from "../ids.js";
import { workBranch } from "../ids.js";
import type { Pre } from "../schemas/events.js";
import type { Plan } from "../schemas/plan.js";
import { applyEntry, replay } from "./replay.js";
import type { State, TaskState } from "./state.js";
import {
  barrierStatus,
  claimableItems,
  isOwner,
  leasesHeldBy,
  pendingReviews,
  statusView,
} from "./views.js";

const REPO = "https://example.invalid/code.git";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function taskOf(state: State, id: TaskId = T1): TaskState {
  const task = state.tasks[id];
  if (!task) throw new Error(`fixture task ${id} missing`);
  return task;
}

/** Register both devices, create `taskId` (solo, owned by VPS) and approve its one-item plan. */
function soloExecuting(
  taskId: TaskId = T1,
  maxParallel: { vps?: number; mac?: number } = {},
): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({
    type: "agent.registered",
    actor: VPS,
    payload: { ...agentRegistered(), max_parallel_items: maxParallel.vps ?? 1 },
  });
  builder.append({
    type: "agent.registered",
    actor: MAC,
    payload: { ...agentRegistered(), max_parallel_items: maxParallel.mac ?? 1 },
  });
  builder.append({
    type: "task.created",
    task_id: taskId,
    actor: "human",
    payload: taskCreated({ repo: REPO, owner: VPS }),
  });
  const plan = samplePlan({ task_id: taskId });
  plan.base.repo = REPO;
  const proposal = planProposed(plan);
  builder.append({
    type: "plan.proposed",
    task_id: taskId,
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.approved",
    task_id: taskId,
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  return { builder, state: replay(builder.entries) };
}

function teamPlan(taskId: TaskId): Plan {
  const first = samplePlan({ task_id: taskId }).items[0];
  if (!first) throw new Error("fixture item missing");
  const plan = samplePlan({
    task_id: taskId,
    mode: "team",
    items: [
      first,
      { ...first, id: "W2", title: "Settings toggle", assignee: MAC, depends_on: ["W1"] },
    ],
    stack_order: ["W1", "W2"],
  });
  plan.base.repo = REPO;
  return plan;
}

/** Team task through plan approval: W1 ready for VPS, W2 blocked for MAC. */
function teamExecuting(): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({
    type: "agent.registered",
    actor: VPS,
    payload: { ...agentRegistered(), max_parallel_items: 2 },
  });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  builder.append({
    type: "task.created",
    actor: "human",
    payload: taskCreated({ repo: REPO, mode: "team", owner: VPS }),
  });
  const plan = teamPlan(T1);
  const proposal = planProposed(plan, [MAC]);
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "review.submitted",
    actor: MAC,
    payload: {
      plan_version: 1,
      plan_hash: proposal.plan_hash,
      verdict: "approve",
      blockers: [],
      suggestions: [],
    },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  builder.append({
    type: "plan.locked",
    actor: VPS,
    payload: { plan_version: 1, plan_hash: proposal.plan_hash, overrides: [], missing_reviews: [] },
    pre: { task_rev: 3, owner_gen: 1, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  builder.append({
    type: "plan.approved",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 4, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  const state = replay(builder.entries);
  if (taskOf(state).status !== "executing") throw new Error("team fixture did not activate");
  return { builder, state };
}

function claim(
  builder: LogBuilder,
  state: State,
  taskId: TaskId,
  item: ItemId,
  actor: AgentId,
): State {
  const task = taskOf(state, taskId);
  const epoch = task.epochs[item] ?? 0;
  const plan = task.plans[String(task.active_plan_version)];
  if (!plan) throw new Error("fixture plan missing");
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "lease.claimed",
        task_id: taskId,
        actor,
        payload: { item, attempt_id: "att_view01", branch: workBranch(taskId, item, epoch + 1) },
        pre: {
          task_rev: task.rev,
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
          item,
          expected_epoch: epoch,
        },
      }),
    ),
  );
}

function deliver(builder: LogBuilder, state: State, item: ItemId, actor: AgentId = VPS): State {
  const task = taskOf(state);
  const lease = task.items[item]?.lease;
  if (!lease) throw new Error(`fixture lease for ${item} missing`);
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "work.delivered",
        actor,
        payload: {
          item,
          epoch: lease.epoch,
          branch: lease.branch,
          head_sha: fakeSha(`head_${item}`),
          pr_url: `https://example.invalid/pull/${item}`,
          pr_number: item === "W1" ? 1 : 2,
          check_runs: [],
        },
        pre: { task_rev: task.rev, item },
      }),
    ),
  );
}

/** Append the event the view itself recommends and return the resulting state. */
function applyClaim(builder: LogBuilder, state: State, actor: AgentId, index = 0): State {
  const candidate = claimableItems(state, actor)[index];
  if (!candidate) throw new Error("no claimable item");
  const task = taskOf(state, candidate.task_id);
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "lease.claimed",
        task_id: candidate.task_id,
        actor,
        payload: { item: candidate.item, attempt_id: "att_view02", branch: candidate.branch },
        pre: {
          task_rev: task.rev,
          plan_version: candidate.plan_version,
          plan_hash: candidate.plan_hash,
          item: candidate.item,
          expected_epoch: candidate.expected_epoch,
        },
      }),
    ),
  );
}

describe("claimableItems", () => {
  it("offers the ready assigned item with the epoch, plan and next work branch", () => {
    const { state } = soloExecuting();
    const plan = taskOf(state).plans["1"];
    expect(claimableItems(state, VPS)).toEqual([
      {
        task_id: T1,
        item: "W1",
        expected_epoch: 0,
        plan_version: 1,
        plan_hash: plan?.plan_hash,
        branch: workBranch(T1, "W1", 1),
      },
    ]);
    expect(claimableItems(state, MAC)).toEqual([]);
  });

  it("returns nothing for an unregistered agent", () => {
    const { state } = soloExecuting();
    expect(claimableItems(state, "mac.review")).toEqual([]);
  });

  it("sorts by task id, then by stack order within a task", () => {
    const builder = new LogBuilder();
    builder.append({
      type: "agent.registered",
      actor: VPS,
      payload: { ...agentRegistered(), max_parallel_items: 1 },
    });
    builder.append({
      type: "agent.registered",
      actor: MAC,
      payload: { ...agentRegistered(), max_parallel_items: 2 },
    });
    const solo = samplePlan({ task_id: T2 });
    solo.base.repo = REPO;
    solo.items[0] = { ...solo.items[0], assignee: MAC } as Plan["items"][number];
    builder.append({
      type: "task.created",
      task_id: T2,
      actor: "human",
      payload: taskCreated({ repo: REPO, owner: VPS }),
    });
    const soloProposal = planProposed(solo);
    builder.append({
      type: "plan.proposed",
      task_id: T2,
      actor: VPS,
      payload: soloProposal,
      pre: { task_rev: 1, owner_gen: 1 },
    });
    builder.append({
      type: "plan.approved",
      task_id: T2,
      actor: "human",
      payload: { plan_version: 1, plan_hash: soloProposal.plan_hash },
      pre: { task_rev: 2, plan_version: 1, plan_hash: soloProposal.plan_hash },
    });
    builder.append({
      type: "task.created",
      task_id: T1,
      actor: "human",
      payload: taskCreated({ repo: REPO, mode: "team", owner: VPS }),
    });
    const plan = teamPlan(T1);
    plan.items[0] = { ...plan.items[0], assignee: MAC } as Plan["items"][number];
    const proposal = planProposed(plan, [MAC]);
    const rev = (id: TaskId): Pre => ({ task_rev: taskOf(replay(builder.entries), id).rev });
    builder.append({
      type: "plan.proposed",
      task_id: T1,
      actor: VPS,
      payload: proposal,
      pre: { ...rev(T1), owner_gen: 1 },
    });
    builder.append({
      type: "review.submitted",
      task_id: T1,
      actor: MAC,
      payload: {
        plan_version: 1,
        plan_hash: proposal.plan_hash,
        verdict: "approve",
        blockers: [],
        suggestions: [],
      },
      pre: { ...rev(T1), plan_version: 1, plan_hash: proposal.plan_hash },
    });
    builder.append({
      type: "plan.locked",
      task_id: T1,
      actor: VPS,
      payload: {
        plan_version: 1,
        plan_hash: proposal.plan_hash,
        overrides: [],
        missing_reviews: [],
      },
      pre: { ...rev(T1), owner_gen: 1, plan_version: 1, plan_hash: proposal.plan_hash },
    });
    builder.append({
      type: "plan.approved",
      task_id: T1,
      actor: "human",
      payload: { plan_version: 1, plan_hash: proposal.plan_hash },
      pre: { ...rev(T1), plan_version: 1, plan_hash: proposal.plan_hash },
    });
    let state = replay(builder.entries);
    // Deliver W1 so W2 (later in stack_order, assigned to MAC) becomes ready too.
    state = claim(builder, state, T1, "W1", MAC);
    expect(replay(builder.entries).outcomes.at(-1)?.outcome).toBe("accepted");
    state = deliver(builder, state, "W1", MAC);
    const mac = claimableItems(state, MAC);
    expect(mac.map((c) => `${c.task_id}/${c.item}`)).toEqual([`${T1}/W2`, `${T2}/W1`]);
  });

  it("accepts exactly the claim it returns, and stops offering once the slot is full", () => {
    const { builder, state } = soloExecuting();
    deepFreeze(state);
    const after = applyClaim(builder, state, VPS);
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(taskOf(after).items.W1?.status).toBe("leased");
    expect(claimableItems(after, VPS)).toEqual([]);
    expect(state.tasks).toEqual(replay(builder.entries.slice(0, -1)).tasks);
  });

  it("never offers an item rejected for max_parallel, retry_budget or barrier_open", () => {
    // One log, two tasks, one parallel slot, so the view and the reducer see the same limit.
    const combined = new LogBuilder();
    combined.append({
      type: "agent.registered",
      actor: VPS,
      payload: { ...agentRegistered(), max_parallel_items: 1 },
    });
    combined.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    for (const taskId of [T1, T2]) {
      combined.append({
        type: "task.created",
        task_id: taskId,
        actor: "human",
        payload: taskCreated({ repo: REPO }),
      });
      const plan = samplePlan({ task_id: taskId });
      plan.base.repo = REPO;
      const proposal = planProposed(plan);
      const created = taskOf(replay(combined.entries), taskId);
      combined.append({
        type: "plan.proposed",
        task_id: taskId,
        actor: VPS,
        payload: proposal,
        pre: { task_rev: created.rev, owner_gen: 1 },
      });
      const proposed = taskOf(replay(combined.entries), taskId);
      combined.append({
        type: "plan.approved",
        task_id: taskId,
        actor: "human",
        payload: { plan_version: 1, plan_hash: proposal.plan_hash },
        pre: { task_rev: proposed.rev, plan_version: 1, plan_hash: proposal.plan_hash },
      });
    }
    let current = replay(combined.entries);
    expect(claimableItems(current, VPS).map((c) => c.task_id)).toEqual([T1, T2]);
    current = applyClaim(combined, current, VPS, 0);
    expect(current.outcomes.at(-1)?.outcome).toBe("accepted");
    // At the parallel limit the view offers nothing, so a direct claim is rejected.
    expect(claimableItems(current, VPS)).toEqual([]);
    const beforeProbe = combined.entries.length;
    expect(activeRejection(combined, current, T2, "W1", beforeProbe)).toBe("max_parallel");

    // A spent retry budget is not offered, and claiming it anyway is rejected. The slot held
    // by T1 is released first so the reducer reaches the budget check rather than max_parallel.
    const held = taskOf(current, T1).items.W1;
    if (held) {
      held.lease = null;
      held.status = "ready";
    }
    const spent = taskOf(current, T2).items.W1;
    if (!spent) throw new Error("fixture item missing");
    spent.attempts_this_plan = taskOf(current, T2).budgets.item_retries + 1;
    expect(claimableItems(current, VPS).map((c) => c.task_id)).toEqual([T1]);
    expect(activeRejection(combined, current, T2, "W1", beforeProbe)).toBe("retry_budget");
    spent.attempts_this_plan = 0;

    // An open barrier hides every item of that task; claiming is rejected as barrier_open.
    taskOf(current, T2).barrier = {
      id: "B9",
      opened_seq: 9,
      closed_seq: null,
      requests: [],
      awaiting: [],
      checkpointed: [],
      escalate: false,
    };
    expect(claimableItems(current, VPS).some((c) => c.task_id === T2)).toBe(false);
    expect(activeRejection(combined, current, T2, "W1", beforeProbe)).toBe("barrier_open");
  });

  it("does not mutate its input, even when the state is deep-frozen", () => {
    const { state } = soloExecuting();
    const before = canonicalJson(state);
    deepFreeze(state);
    expect(() => claimableItems(state, VPS)).not.toThrow();
    expect(canonicalJson(state)).toBe(before);
  });
});

/** Claim directly (bypassing the view) and report the reducer's reason. */
function activeRejection(
  builder: LogBuilder,
  state: State,
  taskId: TaskId,
  item: ItemId,
  keep: number,
): string | null {
  const after = claim(builder, state, taskId, item, VPS);
  const reason = after.outcomes.at(-1)?.reason ?? null;
  // A rejected claim still consumes a log position; drop it so the next probe starts clean.
  builder.entries.length = keep;
  builder.events.length = keep;
  return reason;
}

describe("leasesHeldBy", () => {
  it("lists an active lease as not parked", () => {
    const { builder, state } = soloExecuting();
    const after = claim(builder, state, T1, "W1", VPS);
    expect(leasesHeldBy(after, VPS)).toEqual([
      {
        task_id: T1,
        item: "W1",
        epoch: 1,
        branch: workBranch(T1, "W1", 1),
        interrupt: null,
        parked: false,
      },
    ]);
    expect(leasesHeldBy(after, MAC)).toEqual([]);
  });

  it("marks a checkpointed lease parked and keeps a flagged one active (D16)", () => {
    const { builder, state } = soloExecuting();
    const leased = claim(builder, state, T1, "W1", VPS);
    const task = taskOf(leased);
    const lease = task.items.W1?.lease;
    if (!lease) throw new Error("fixture lease missing");
    // Constructed: SK-202 owns the barrier handlers that would produce this state.
    task.barrier = {
      id: "B7",
      opened_seq: 7,
      closed_seq: null,
      requests: [
        {
          seq: 7,
          event_id: "evt_00000000-0000-4000-8000-000000000007",
          actor: VPS,
          summary: "Base branch moved",
          evidence_count: 1,
        },
      ],
      awaiting: ["W1"],
      checkpointed: [],
      escalate: false,
    };
    lease.interrupt = "B7";
    task.status = "interrupting";
    expect(leasesHeldBy(leased, VPS)).toEqual([
      expect.objectContaining({ item: "W1", interrupt: "B7", parked: false }),
    ]);

    const item = task.items.W1;
    if (!item) throw new Error("fixture item missing");
    item.status = "interrupted";
    task.barrier.checkpointed = ["W1"];
    const held = leasesHeldBy(leased, VPS);
    expect(held).toEqual([
      {
        task_id: T1,
        item: "W1",
        epoch: 1,
        branch: lease.branch,
        interrupt: "B7",
        parked: true,
      },
    ]);
    expect(held[0]?.parked).toBe(true);
  });
});

describe("isOwner", () => {
  it("is true only for the task's current owner", () => {
    const { state } = soloExecuting();
    expect(isOwner(state, T1, VPS)).toBe(true);
    expect(isOwner(state, T1, MAC)).toBe(false);
    expect(isOwner(state, T2, VPS)).toBe(false);
  });
});

describe("pendingReviews", () => {
  it("lists a reviewer's current plan until they submit, then drops it", () => {
    const builder = new LogBuilder();
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    builder.append({
      type: "task.created",
      actor: "human",
      payload: taskCreated({ repo: REPO, mode: "team" }),
    });
    const plan = teamPlan(T1);
    const proposal = planProposed(plan, [MAC]);
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      payload: proposal,
      pre: { task_rev: 1, owner_gen: 1 },
    });
    const reviewing = replay(builder.entries);
    expect(taskOf(reviewing).status).toBe("reviewing");
    expect(pendingReviews(reviewing, MAC)).toEqual([
      { task_id: T1, plan_version: 1, plan_hash: proposal.plan_hash },
    ]);
    expect(pendingReviews(reviewing, VPS)).toEqual([]);

    builder.append({
      type: "review.submitted",
      actor: MAC,
      payload: {
        plan_version: 1,
        plan_hash: proposal.plan_hash,
        verdict: "approve",
        blockers: [],
        suggestions: [],
      },
      pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
    });
    expect(pendingReviews(replay(builder.entries), MAC)).toEqual([]);
  });

  it("ignores a review recorded against a plan that is no longer in review", () => {
    const { state } = soloExecuting();
    expect(pendingReviews(state, VPS)).toEqual([]);
  });
});

describe("barrierStatus", () => {
  it("returns null when the task has no barrier or does not exist", () => {
    const { state } = soloExecuting();
    expect(barrierStatus(state, T1)).toBeNull();
    expect(barrierStatus(state, T2)).toBeNull();
  });

  it("splits awaiting items into settled and missing via isSettled", () => {
    const { builder, state } = teamExecuting();
    const leased = claim(builder, state, T1, "W1", VPS);
    const task = taskOf(leased);
    const w2 = task.items.W2;
    if (!w2) throw new Error("fixture item missing");
    // W2 never held a lease; a release-equivalent settlement is lease === null (isSettled).
    task.barrier = {
      id: "B8",
      opened_seq: 8,
      closed_seq: null,
      requests: [
        {
          seq: 8,
          event_id: "evt_00000000-0000-4000-8000-000000000008",
          actor: "human",
          summary: "Replan",
          evidence_count: 0,
        },
        {
          seq: 9,
          event_id: "evt_00000000-0000-4000-8000-000000000009",
          actor: VPS,
          summary: "Same barrier",
          evidence_count: 1,
        },
      ],
      awaiting: ["W2", "W1"],
      checkpointed: ["W2"],
      escalate: true,
    };
    expect(barrierStatus(leased, T1)).toEqual({
      id: "B8",
      open: true,
      awaiting: ["W1", "W2"],
      settled: ["W2"],
      missing: ["W1"],
      escalate: true,
      request_count: 2,
    });

    task.barrier.closed_seq = 10;
    task.barrier.checkpointed = ["W1", "W2"];
    const closed = barrierStatus(leased, T1);
    expect(closed).toMatchObject({ open: false, settled: ["W1", "W2"], missing: [] });
  });
});

describe("statusView", () => {
  it("projects agents and tasks with sorted keys and no provider information (D19)", () => {
    const { builder, state } = teamExecuting();
    const leased = claim(builder, state, T1, "W1", VPS);
    const view = statusView(leased);
    expect(view.seq).toBe(leased.seq);
    expect(view.tip).toBe(leased.tip);
    expect(view.agents.map((a) => a.id)).toEqual([MAC, VPS]);
    expect(view.agents[1]).toEqual({
      id: VPS,
      device: "vps",
      agent_cli: "codex",
      cli_version: "0.0.0-test",
      max_parallel_items: 2,
    });
    const task = view.tasks[0];
    expect(task).toMatchObject({
      task_id: T1,
      status: "executing",
      mode: "team",
      owner: VPS,
      owner_gen: 1,
      current_plan_version: 1,
      active_plan_version: 1,
      barrier: null,
      escalation: null,
      verified: null,
      replan_count: 0,
      replan_budget: 2,
      review_rounds: 0,
      review_round_budget: 2,
    });
    expect(task?.items.map((i) => i.id)).toEqual(["W1", "W2"]);
    expect(task?.items[0]).toMatchObject({
      status: "leased",
      assignee: VPS,
      epoch: 1,
      holder: VPS,
      parked: false,
    });
    expect(task?.items[1]).toMatchObject({ status: "blocked", holder: null, parked: false });
    const json = canonicalJson(view);
    expect(json).not.toMatch(/provider|credential|api_key|capabilities|requires_local/i);
    expect(Object.keys(view.agents[0] ?? {}).sort()).toEqual([
      "agent_cli",
      "cli_version",
      "device",
      "id",
      "max_parallel_items",
    ]);
  });

  it("shows escalation.reason verification_failed and the verified record (D14)", () => {
    const { builder, state } = soloExecuting();
    let current = claim(builder, state, T1, "W1", VPS);
    current = deliver(builder, current, "W1");
    expect(taskOf(current).status).toBe("delivered");
    const head = taskOf(current).items.W1?.delivered?.head_sha;
    current = applyEntry(
      current,
      builder.appendRaw(
        builder.event({
          type: "task.verified",
          actor: VPS,
          payload: { top_of_stack_sha: head ?? fakeSha("missing"), passed: false, check_runs: [] },
          pre: {
            task_rev: taskOf(current).rev,
            owner_gen: 1,
            plan_hash: taskOf(current).plans["1"]?.plan_hash,
          },
        }),
      ),
    );
    expect(current.outcomes.at(-1)?.outcome).toBe("accepted");
    const view = statusView(current);
    expect(view.tasks[0]?.status).toBe("escalated");
    expect(view.tasks[0]?.escalation).toEqual({
      reason: "verification_failed",
      seq: current.seq,
    });
    expect(view.tasks[0]?.verified).toEqual({
      top_of_stack_sha: head,
      passed: false,
      seq: current.seq,
    });
  });

  it("marks a parked lease and reports barrier status inside the task", () => {
    const { builder, state } = soloExecuting();
    const leased = claim(builder, state, T1, "W1", VPS);
    const task = taskOf(leased);
    const item = task.items.W1;
    if (!item?.lease) throw new Error("fixture lease missing");
    item.status = "interrupted";
    item.lease.interrupt = "B4";
    task.status = "interrupting";
    task.replan_count = 1;
    task.barrier = {
      id: "B4",
      opened_seq: 4,
      closed_seq: null,
      requests: [],
      awaiting: ["W1"],
      checkpointed: ["W1"],
      escalate: false,
    };
    const view = statusView(leased);
    expect(view.tasks[0]?.items[0]).toMatchObject({
      status: "interrupted",
      parked: true,
      epoch: 1,
    });
    expect(view.tasks[0]?.barrier).toMatchObject({
      id: "B4",
      open: true,
      settled: ["W1"],
      missing: [],
    });
    expect(view.tasks[0]?.replan_count).toBe(1);
  });

  it("is stable JSON: canonical form survives a re-parse and two replays match", () => {
    const { builder, state } = teamExecuting();
    const leased = claim(builder, state, T1, "W1", VPS);
    deepFreeze(leased);
    const view = statusView(leased);
    const again = statusView(replay(builder.entries));
    const text = canonicalJson(view);
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(canonicalJson(again)).toBe(text);
    expect(again).toEqual(view);
    // Insertion order of the source records must not leak into the projection.
    const reversed = structuredClone(leased);
    reversed.agents = Object.fromEntries(Object.entries(reversed.agents).reverse());
    reversed.tasks = Object.fromEntries(
      Object.entries(reversed.tasks).flatMap(([id, task]) => {
        task.items = Object.fromEntries(Object.entries(task.items).reverse());
        return [[id, task]];
      }),
    );
    expect(canonicalJson(statusView(reversed))).toBe(text);
  });

  it("does not mutate a deep-frozen state", () => {
    const { state } = soloExecuting();
    const before = canonicalJson(state);
    deepFreeze(state);
    statusView(state);
    leasesHeldBy(state, VPS);
    pendingReviews(state, MAC);
    barrierStatus(state, T1);
    isOwner(state, T1, VPS);
    expect(canonicalJson(state)).toBe(before);
  });
});
