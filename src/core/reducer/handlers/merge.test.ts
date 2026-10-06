import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  fakeSha,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../../../test/helpers/log-builder.js";
import { canonicalJson } from "../../canonical.js";
import { workBranch } from "../../ids.js";
import type { PayloadOf } from "../../schemas/events.js";
import { applyEntry, replay } from "../replay.js";
import type { State, TaskState } from "../state.js";

function task(state: State): TaskState {
  const result = state.tasks[T1];
  if (!result) throw new Error("fixture task missing");
  return result;
}

function fixture(deliveryCount = 0): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const created = taskCreated({ repo: "https://example.invalid/code.git", mode: "team" });
  builder.append({ type: "task.created", actor: "human", payload: created });
  const plan = samplePlan({ mode: "team" });
  plan.base.repo = created.repo;
  const first = plan.items[0];
  if (!first) throw new Error("fixture plan item missing");
  plan.items = [
    first,
    { ...first, id: "W2", title: "Second change", assignee: MAC, depends_on: ["W1"] },
  ];
  // Deliberately reverse definition order: stack_order alone selects the verified head.
  plan.items.reverse();
  plan.stack_order = ["W1", "W2"];
  const proposal = planProposed(plan, [MAC]);
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.locked",
    actor: VPS,
    payload: {
      plan_version: 1,
      plan_hash: proposal.plan_hash,
      overrides: [],
      missing_reviews: [MAC],
    },
    pre: { task_rev: 2, owner_gen: 1, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  builder.append({
    type: "plan.approved",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 3, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  let state = replay(builder.entries);
  for (const id of ["W1", "W2"].slice(0, deliveryCount)) state = deliver(builder, state, id);
  return { builder, state };
}

function deliver(builder: LogBuilder, state: State, id: string): State {
  const t = task(state);
  const actor = t.items[id]?.assignee ?? VPS;
  const epoch = (t.epochs[id] ?? 0) + 1;
  state = applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "lease.claimed",
        actor,
        payload: { item: id, attempt_id: "att_merge", branch: workBranch(T1, id, epoch) },
        pre: {
          task_rev: t.rev,
          plan_version: 1,
          plan_hash: t.plans["1"]?.plan_hash,
          item: id,
          expected_epoch: epoch - 1,
        },
      }),
    ),
  );
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "work.delivered",
        actor,
        payload: {
          item: id,
          epoch,
          branch: workBranch(T1, id, epoch),
          head_sha: fakeSha(id),
          pr_url: `https://example.invalid/pull/${id === "W1" ? 1 : 2}`,
          pr_number: id === "W1" ? 1 : 2,
          check_runs: [],
        },
        pre: { task_rev: task(state).rev, item: id },
      }),
    ),
  );
}

function append<T extends "item.merged" | "task.verified">(
  builder: LogBuilder,
  state: State,
  type: T,
  payload: PayloadOf<T>,
  actor = type === "item.merged" ? "human" : VPS,
): State {
  const t = task(state);
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type,
        actor,
        payload,
        pre: {
          task_rev: t.rev,
          owner_gen: t.owner_gen,
          plan_hash: t.plans["1"]?.plan_hash,
          ...("item" in payload ? { item: payload.item } : {}),
        },
      }),
    ),
  );
}

function merge(id = "W1", prNumber = id === "W1" ? 1 : 2): PayloadOf<"item.merged"> {
  return { item: id, pr_number: prNumber, merge_sha: fakeSha(`merged_${id}`) };
}

function verification(id = "W2", passed = true): PayloadOf<"task.verified"> {
  return { top_of_stack_sha: fakeSha(id), passed, check_runs: [] };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("stack integration and completion", () => {
  it("verifies only W2's head and completes after W1 and W2 are merged", () => {
    const { builder, state: delivered } = fixture(2);
    expect(task(delivered).status).toBe("delivered");
    let state = append(builder, delivered, "task.verified", verification("W1"));
    expect(state.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(state.tasks).toEqual(delivered.tasks);
    state = append(builder, state, "task.verified", verification());
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state).verified).toEqual({
      top_of_stack_sha: fakeSha("W2"),
      passed: true,
      seq: state.seq,
    });
    state = append(builder, state, "item.merged", merge());
    expect(task(state).status).toBe("delivered");
    expect(task(state).items.W1).toMatchObject({
      status: "merged",
      merged: { pr_number: 1, merge_sha: fakeSha("merged_W1"), seq: state.seq },
    });
    state = append(builder, state, "item.merged", merge("W2"), MAC);
    expect(task(state).status).toBe("done");
    const { item: _item, ...record } = merge("W2");
    expect(task(state).items.W2?.merged).toEqual({ ...record, seq: state.seq });
    expect(state.outcomes.slice(-4).map((o) => o.outcome)).toEqual([
      "rejected",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(state).toEqual(replay(builder.entries));
  });

  it("rejects a mismatched PR number without modifying delivery or merge state", () => {
    const { builder, state } = fixture(2);
    const after = append(builder, state, "item.merged", merge("W1", 99));
    expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(after.tasks).toEqual(state.tasks);
  });

  it("rejects merging an undelivered item", () => {
    const { builder, state } = fixture();
    const after = append(builder, state, "item.merged", merge());
    expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(after.tasks).toEqual(state.tasks);
  });

  it("rejects repeated merging while another item remains unmerged", () => {
    const { builder, state: delivered } = fixture(2);
    const state = append(builder, delivered, "item.merged", merge());
    const after = append(builder, state, "item.merged", merge());
    expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(after.tasks).toEqual(state.tasks);
  });

  it("accepts an early merge and still delivers and verifies the remaining stack", () => {
    const { builder, state: firstDelivered } = fixture(1);
    let state = append(builder, firstDelivered, "item.merged", merge());
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state)).toMatchObject({ status: "executing", items: { W2: { status: "ready" } } });
    state = deliver(builder, state, "W2");
    expect(task(state).status).toBe("delivered");
    state = append(builder, state, "task.verified", verification());
    state = append(builder, state, "item.merged", merge("W2"));
    expect(task(state).status).toBe("done");
    expect(replay(builder.entries)).toEqual(state);
  });

  it("permits observed merges in an escalated task", () => {
    const { builder, state } = fixture(2);
    task(state).status = "escalated";
    task(state).escalation = { reason: "item_failed", seq: state.seq };
    let after = append(builder, state, "item.merged", merge());
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(after).status).toBe("escalated");
    after = append(builder, after, "item.merged", merge("W2"));
    expect(task(after).status).toBe("done");
  });

  it.each(["interrupting", "replanning", "planning"] as const)(
    "rejects a merge in %s",
    (status) => {
      const { builder, state } = fixture(2);
      task(state).status = status;
      const after = append(builder, state, "item.merged", merge());
      expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it("keeps a failed verification result without completing the task", () => {
    const { builder, state } = fixture(2);
    const after = append(builder, state, "task.verified", verification("W2", false));
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(after)).toMatchObject({
      status: "delivered",
      verified: { top_of_stack_sha: fakeSha("W2"), passed: false, seq: after.seq },
    });
  });

  it.each(["executing", "interrupting", "replanning", "escalated"] as const)(
    "rejects verification in %s",
    (status) => {
      const { builder, state } = fixture(2);
      task(state).status = status;
      const after = append(builder, state, "task.verified", verification());
      expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it("rejects verification with missing top-item delivery", () => {
    const { builder, state } = fixture(2);
    const top = task(state).items.W2;
    if (top) top.delivered = null;
    const after = append(builder, state, "task.verified", verification());
    expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(after.tasks).toEqual(state.tasks);
  });
});

describe("completed handler purity and determinism", () => {
  it("replays identically from every prefix without mutating deeply frozen inputs", () => {
    const { builder, state: delivered } = fixture(2);
    let state = append(builder, delivered, "task.verified", verification("W1"));
    state = append(builder, state, "task.verified", verification());
    state = append(builder, state, "item.merged", merge("W1", 99));
    state = append(builder, state, "item.merged", merge());
    state = append(builder, state, "item.merged", merge("W2"));
    const entries = freeze(builder.entries);
    const expected = canonicalJson(state);
    expect(canonicalJson(replay(entries))).toBe(expected);
    expect(canonicalJson(replay(entries))).toBe(expected);
    for (let prefix = 1; prefix <= entries.length; prefix++) {
      let current = freeze(replay(entries.slice(0, prefix)));
      for (const entry of entries.slice(prefix)) {
        const before = canonicalJson(current);
        const after = applyEntry(current, entry);
        expect(canonicalJson(current)).toBe(before);
        expect(after).not.toBe(current);
        current = freeze(after);
      }
      expect(canonicalJson(current), `prefix ${prefix}`).toBe(expected);
      expect(JSON.parse(JSON.stringify(current))).toEqual(current);
    }
  });
});
