import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  T2,
  taskCreated,
  VPS,
} from "../../../../test/helpers/log-builder.js";
import type { LogEntry } from "../../log.js";
import type { PayloadOf } from "../../schemas/events.js";
import { applyEntry, replay } from "../replay.js";
import type { State, TaskState } from "../state.js";

function registered(): LogBuilder {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  return builder;
}

function planning(): LogBuilder {
  const builder = registered();
  builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
  return builder;
}

function escalated(): LogBuilder {
  const builder = registered();
  const payload = taskCreated();
  payload.budgets.review_rounds = 0;
  builder.append({ type: "task.created", actor: "human", payload });
  const proposal = planProposed();
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.rejected",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  return builder;
}

function task(state: State): TaskState {
  const result = state.tasks[T1];
  if (!result) throw new Error("fixture task missing");
  return result;
}

function executing(): { builder: LogBuilder; state: State } {
  const builder = planning();
  const proposal = planProposed();
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.approved",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  return { builder, state: replay(builder.entries) };
}

function addLeaseAndBarrier(t: TaskState): void {
  const item = t.items.W1;
  if (!item) throw new Error("fixture item missing");
  item.status = "leased";
  item.lease = {
    epoch: 1,
    holder: VPS,
    attempt_id: "att_test",
    branch: `skep/${T1}/W1/e1`,
    plan_version: 1,
    plan_hash: planProposed().plan_hash,
    granted_at_seq: 6,
    interrupt: "B6",
  };
  item.attempts_this_plan = 2;
  t.epochs.W1 = 1;
  t.barrier = {
    id: "B6",
    opened_seq: 6,
    closed_seq: null,
    requests: [],
    awaiting: ["W1"],
    checkpointed: [],
    escalate: true,
  };
}

describe("task handlers", () => {
  it("upserts only the signing device's agent profile", () => {
    const builder = registered();
    builder.append({
      type: "agent.registered",
      actor: VPS,
      payload: { ...agentRegistered(), capabilities: ["swift"], max_parallel_items: 2 },
    });
    const state = replay(builder.entries);
    expect(state.agents[VPS]).toEqual({
      agent: VPS,
      device: "vps",
      profile: { ...agentRegistered(), capabilities: ["swift"], max_parallel_items: 2 },
      registered_seq: 3,
    });
    expect(state.tasks).toEqual({});
    expect(state.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
  });

  it("creates a planning task with rev 1 and initialized JSON fields", () => {
    const state = replay(planning().entries);
    expect(task(state)).toMatchObject({
      status: "planning",
      rev: 1,
      owner: VPS,
      owner_gen: 1,
      created_seq: 3,
      last_seq: 3,
      plans: {},
      items: {},
      epochs: {},
      current_plan_version: null,
      active_plan_version: null,
      barrier: null,
      review_rounds: 0,
      replan_count: 0,
      escalation: null,
      verified: null,
      cancelled: null,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("rejects an unregistered owner", () => {
    const builder = new LogBuilder();
    const event = builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
    const state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("unknown_agent");
    expect(state.tasks).toEqual({});
    expect(state.seen_event_ids[event.event_id]).toBe(1);
  });

  it("rejects creating an existing task", () => {
    const builder = planning();
    builder.append({
      type: "task.created",
      actor: "human",
      payload: taskCreated({ title: "Replacement" }),
    });
    const state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("task_exists");
    expect(task(state).title).toBe(taskCreated().title);
    expect(task(state).rev).toBe(1);
  });

  it("rejects events for an unknown task", () => {
    const builder = registered();
    builder.append({
      type: "task.cancelled",
      task_id: T2,
      actor: "human",
      payload: { reason: "Cancel" },
      pre: { task_rev: 0 },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("unknown_task");
    builder.append({
      type: "plan.proposed",
      task_id: T2,
      actor: VPS,
      payload: planProposed(samplePlan({ task_id: T2 })),
      pre: { task_rev: 0, owner_gen: 1 },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("unknown_task");
  });

  it("cancels the task, clearing all leases and the barrier", () => {
    const { builder, state } = executing();
    addLeaseAndBarrier(task(state));
    builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "No longer needed" },
      pre: { task_rev: 3 },
    });
    const after = applyEntry(state, builder.entries.at(-1) as LogEntry);
    expect(task(after)).toMatchObject({
      status: "cancelled",
      rev: 4,
      barrier: null,
      cancelled: { reason: "No longer needed", seq: 6 },
      items: { W1: { lease: null } },
    });
    expect(task(state).items.W1?.lease).not.toBeNull();
  });

  it.each(["done", "cancelled"] as const)(
    "rejects further events for terminal task status %s before preconditions",
    (status) => {
      const builder = planning();
      const state = replay(builder.entries);
      task(state).status = status;
      builder.append({
        type: "owner.transferred",
        actor: "human",
        payload: { new_owner: MAC },
        pre: { task_rev: 99, owner_gen: 99 },
      });
      const after = applyEntry(state, builder.entries.at(-1) as LogEntry);
      expect(after.outcomes.at(-1)?.reason).toBe("task_terminal");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it("transfers ownership, fencing old owners and stale generations", () => {
    const builder = planning();
    builder.append({
      type: "owner.transferred",
      actor: "human",
      payload: { new_owner: MAC },
      pre: { task_rev: 1, owner_gen: 1 },
    });
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(),
      pre: { task_rev: 2, owner_gen: 2 },
    });
    builder.append({
      type: "plan.proposed",
      actor: MAC,
      payload: planProposed(),
      pre: { task_rev: 2, owner_gen: 1 },
    });
    builder.append({
      type: "plan.proposed",
      actor: MAC,
      payload: planProposed(),
      pre: { task_rev: 2, owner_gen: 2 },
    });
    const state = replay(builder.entries);
    expect(state.outcomes.slice(-3).map((outcome) => outcome.reason)).toEqual([
      "unauthorized",
      "pre_mismatch",
      null,
    ]);
    expect(task(state)).toMatchObject({
      owner: MAC,
      owner_gen: 2,
      rev: 3,
      plans: { "1": { owner_gen: 2 } },
    });
  });

  it("rejects transferring ownership to an unknown agent", () => {
    const builder = planning();
    builder.append({
      type: "owner.transferred",
      actor: "human",
      payload: { new_owner: "mac.coding.2" },
      pre: { task_rev: 1, owner_gen: 1 },
    });
    const state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("unknown_agent");
    expect(task(state)).toMatchObject({ owner: VPS, owner_gen: 1, rev: 1 });
  });
});

describe("human escalation decisions", () => {
  it("reassigns the owner, increments owner_gen and rejects the previous owner's proposal", () => {
    const builder = escalated();
    builder.append({
      type: "human.decided",
      actor: "human",
      payload: { decision: "reassign_owner", new_owner: MAC },
      pre: { task_rev: 3 },
    });
    expect(task(replay(builder.entries))).toMatchObject({
      status: "planning",
      owner: MAC,
      owner_gen: 2,
      rev: 4,
      escalation: null,
    });
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(samplePlan({ version: 2, parent_version: 1 })),
      pre: { task_rev: 4, owner_gen: 2 },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("unauthorized");
  });

  it("returns to planning after a replan decision", () => {
    const builder = escalated();
    builder.append({
      type: "human.decided",
      actor: "human",
      payload: { decision: "replan" },
      pre: { task_rev: 3 },
    });
    expect(task(replay(builder.entries))).toMatchObject({
      status: "planning",
      rev: 4,
      escalation: null,
      review_rounds: 1,
    });
  });

  it.each(["failed", "unknown", "interrupted"] as const)(
    "resumes the active plan with %s work ready and attempts reset",
    (status) => {
      const { builder, state } = executing();
      const t = task(state);
      addLeaseAndBarrier(t);
      t.status = "escalated";
      t.escalation = { reason: "retry_budget", seq: 5 };
      if (t.items.W1) t.items.W1.status = status;
      builder.append({
        type: "human.decided",
        actor: "human",
        payload: { decision: "resume_with_plan" },
        pre: { task_rev: 3 },
      });
      const after = applyEntry(state, builder.entries.at(-1) as LogEntry);
      expect(task(after)).toMatchObject({
        status: "executing",
        barrier: null,
        escalation: null,
        rev: 4,
        epochs: { W1: 1 },
        items: { W1: { status: "ready", lease: null, attempts_this_plan: 0 } },
      });
    },
  );

  it("cancels an escalated task with leases and a barrier", () => {
    const { builder, state } = executing();
    const t = task(state);
    addLeaseAndBarrier(t);
    t.status = "escalated";
    t.escalation = { reason: "replans", seq: 5 };
    builder.append({
      type: "human.decided",
      actor: "human",
      payload: { decision: "cancel", note: "Stop now" },
      pre: { task_rev: 3 },
    });
    const after = applyEntry(state, builder.entries.at(-1) as LogEntry);
    expect(task(after)).toMatchObject({
      status: "cancelled",
      escalation: null,
      barrier: null,
      cancelled: { reason: "Stop now", seq: 6 },
      items: { W1: { lease: null } },
    });
  });

  it.each([
    [{ decision: "resume_with_plan" }, "bad_decision"],
    [{ decision: "reassign_owner", new_owner: "mac.coding.2" }, "unknown_agent"],
  ] satisfies [PayloadOf<"human.decided">, string][])(
    "rejects unsupported decision %j without changing task state",
    (payload, reason) => {
      const builder = escalated();
      const before = replay(builder.entries);
      builder.append({ type: "human.decided", actor: "human", payload, pre: { task_rev: 3 } });
      const after = replay(builder.entries);
      expect(after.outcomes.at(-1)?.reason).toBe(reason);
      expect(after.tasks).toEqual(before.tasks);
    },
  );

  it("allows escalation decisions only while escalated", () => {
    const builder = planning();
    builder.append({
      type: "human.decided",
      actor: "human",
      payload: { decision: "replan" },
      pre: { task_rev: 1 },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("bad_task_state");
  });
});
