import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  planProposed,
  T1,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import type { LogEntry } from "../log.js";
import type { Pre } from "../schemas/events.js";
import { applyEntry, replay } from "./replay.js";

function executing(): LogBuilder {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
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
  return builder;
}

describe("present precondition comparisons (ARCHITECTURE §4.2)", () => {
  it.each([
    [{ task_rev: 2 }, "pre_mismatch"],
    [{ owner_gen: 2 }, "pre_mismatch"],
    [{ plan_version: 2 }, "plan_changed"],
    [{ plan_hash: `sha256:${"a".repeat(64)}` }, "plan_changed"],
    [{ item: "W2" }, "unknown_item"],
    [{ item: "W1", expected_epoch: 1 }, "epoch_mismatch"],
    [{ expected_epoch: 0 }, "unknown_item"],
  ] satisfies [Pre, string][])("rejects mismatched pre %j as %s", (pre, reason) => {
    const builder = executing();
    const before = replay(builder.entries);
    const event = builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Cancel" },
      pre: { task_rev: 3, ...pre },
    });
    const after = replay(builder.entries);
    expect(after.outcomes.at(-1)).toMatchObject({ outcome: "rejected", reason });
    expect(after.tasks).toEqual(before.tasks);
    expect(after.seen_event_ids[event.event_id]).toBe(5);
  });

  it("accepts matching values, including the default epoch zero", () => {
    const builder = executing();
    builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Cancel" },
      pre: {
        task_rev: 3,
        owner_gen: 1,
        plan_version: 1,
        plan_hash: planProposed().plan_hash,
        item: "W1",
        expected_epoch: 0,
      },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.outcome).toBe("accepted");
  });

  it("compares the highest granted epoch, not the item status", () => {
    const builder = executing();
    const state = replay(builder.entries);
    const task = state.tasks[T1];
    if (!task) throw new Error("fixture task missing");
    task.epochs.W1 = 7;
    builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Cancel" },
      pre: { task_rev: 3, item: "W1", expected_epoch: 7 },
    });
    const after = applyEntry(state, builder.entries.at(-1) as LogEntry);
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(after.tasks[T1]?.epochs.W1).toBe(7);
  });

  it("rejects task preconditions attached to a cluster event without task context", () => {
    const builder = new LogBuilder();
    builder.append({
      type: "agent.registered",
      actor: VPS,
      payload: agentRegistered(),
      pre: { task_rev: 0 },
    });
    const state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("pre_mismatch");
    expect(state.agents).toEqual({});
  });
});
