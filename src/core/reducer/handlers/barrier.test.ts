import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../../../test/helpers/log-builder.js";
import { workBranch } from "../../ids.js";
import { replay } from "../replay.js";
import type { TaskState } from "../state.js";
import { isSettled, settleBarrier } from "./barrier.js";

function interrupting(escalate = false): TaskState {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const created = taskCreated({ repo: "https://example.invalid/code.git" });
  builder.append({ type: "task.created", actor: "human", payload: created });
  const plan = samplePlan();
  plan.base.repo = created.repo;
  const proposal = planProposed(plan);
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
  const task = replay(builder.entries).tasks[T1];
  if (!task?.items.W1) throw new Error("fixture task or item missing");
  task.items.W2 = {
    ...structuredClone(task.items.W1),
    id: "W2",
    assignee: MAC,
    depends_on: ["W1"],
  };
  task.barrier = {
    id: "B8",
    opened_seq: 8,
    closed_seq: null,
    requests: [],
    awaiting: ["W1", "W2"],
    checkpointed: [],
    escalate,
  };
  task.status = "interrupting";
  for (const item of Object.values(task.items)) {
    item.status = "leased";
    item.attempts_this_plan = 1;
    task.epochs[item.id] = 1;
    item.lease = {
      epoch: 1,
      holder: item.assignee,
      attempt_id: "att_barrier",
      branch: workBranch(T1, item.id, 1),
      plan_version: 1,
      plan_hash: proposal.plan_hash,
      granted_at_seq: 6,
      interrupt: "B8",
    };
  }
  return task;
}

describe("barrier settlement", () => {
  it("requires a checkpoint or a cleared lease", () => {
    const task = interrupting();
    const before = structuredClone(task);
    expect(isSettled(task, "W1")).toBe(false);
    expect(isSettled(task, "W2")).toBe(false);
    expect(task).toEqual(before);
    task.barrier?.checkpointed.push("W1");
    expect(isSettled(task, "W1")).toBe(true);
    expect(task.items.W1?.lease).not.toBeNull();
    const item = task.items.W2;
    if (item) item.lease = null;
    expect(isSettled(task, "W2")).toBe(true);
  });

  it("does not treat a missing item as a cleared lease", () => {
    expect(isSettled(interrupting(), "W3")).toBe(false);
  });

  it.each(["ready", "failed", "unknown"] as const)(
    "recognizes a cleared lease with %s status",
    (status) => {
      const task = interrupting();
      const item = task.items.W1;
      if (!item) throw new Error("fixture item missing");
      item.lease = null;
      item.status = status;
      expect(isSettled(task, "W1")).toBe(true);
    },
  );

  it("leaves a partially settled barrier unchanged", () => {
    const task = interrupting();
    task.barrier?.checkpointed.push("W1");
    const before = structuredClone(task);
    settleBarrier(task, 9);
    expect(task).toEqual(before);
  });

  it.each([false, true])("closes once all items settle (escalate=%s)", (escalate) => {
    const task = interrupting(escalate);
    task.barrier?.checkpointed.push("W1");
    const second = task.items.W2;
    if (second) second.lease = null;
    const before = structuredClone(task);
    settleBarrier(task, 10);
    expect(task.barrier).toEqual({ ...before.barrier, closed_seq: 10 });
    expect(task.status).toBe(escalate ? "escalated" : "replanning");
    expect(task.escalation).toEqual(escalate ? { reason: "replans", seq: 10 } : null);
    expect(task.items).toEqual(before.items);
    expect(task.replan_count).toBe(before.replan_count);
    const settled = structuredClone(task);
    settleBarrier(task, 11);
    expect(task).toEqual(settled);
  });

  it("settles all checkpoints even when interrupted leases remain", () => {
    const task = interrupting();
    if (task.barrier) task.barrier.checkpointed = ["W1", "W2"];
    settleBarrier(task, 10);
    expect(task.status).toBe("replanning");
    expect(task.barrier?.closed_seq).toBe(10);
    expect(task.items.W1?.lease).not.toBeNull();
    expect(task.items.W2?.lease).not.toBeNull();
  });

  it.each([false, true])("immediately settles an empty awaiting list (escalate=%s)", (escalate) => {
    const task = interrupting(escalate);
    if (task.barrier) task.barrier.awaiting = [];
    settleBarrier(task, 8);
    expect(task.barrier?.closed_seq).toBe(8);
    expect(task.status).toBe(escalate ? "escalated" : "replanning");
  });

  it("ignores leases outside the awaiting list", () => {
    const task = interrupting();
    if (task.barrier) {
      task.barrier.awaiting = ["W1"];
      task.barrier.checkpointed = ["W1"];
    }
    settleBarrier(task, 9);
    expect(task.status).toBe("replanning");
    expect(task.items.W2?.lease).not.toBeNull();
  });

  it("does nothing without a barrier", () => {
    const task = interrupting();
    task.barrier = null;
    const before = structuredClone(task);
    settleBarrier(task, 9);
    expect(task).toEqual(before);
  });

  it("does nothing for an already closed barrier", () => {
    const task = interrupting(true);
    if (task.barrier) task.barrier.closed_seq = 9;
    task.status = "replanning";
    const before = structuredClone(task);
    settleBarrier(task, 10);
    expect(task).toEqual(before);
  });
});
