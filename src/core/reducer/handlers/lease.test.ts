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
} from "../../../../test/helpers/log-builder.js";
import { canonicalJson } from "../../canonical.js";
import { workBranch } from "../../ids.js";
import type { EventOf, PayloadOf } from "../../schemas/events.js";
import { applyEntry, replay } from "../replay.js";
import type { State, TaskState } from "../state.js";
import { settleBarrier } from "./barrier.js";
import { handleLeaseClaimed } from "./lease.js";

const REPO = "https://example.invalid/code.git";

function addTask(builder: LogBuilder, taskId = T1): void {
  builder.append({
    type: "task.created",
    task_id: taskId,
    actor: "human",
    payload: taskCreated({ repo: REPO }),
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
}

function executing(maxParallel = 1): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({
    type: "agent.registered",
    actor: VPS,
    payload: { ...agentRegistered(), max_parallel_items: maxParallel },
  });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  addTask(builder);
  return { builder, state: replay(builder.entries) };
}

function task(state: State, id = T1): TaskState {
  const result = state.tasks[id];
  if (!result) throw new Error("fixture task missing");
  return result;
}

function claimEvent(builder: LogBuilder, state: State, taskId = T1): EventOf<"lease.claimed"> {
  const t = task(state, taskId);
  const epoch = t.epochs.W1 ?? 0;
  return builder.event({
    type: "lease.claimed",
    task_id: taskId,
    actor: VPS,
    payload: { item: "W1", attempt_id: "att_test", branch: workBranch(taskId, "W1", epoch + 1) },
    pre: {
      task_rev: t.rev,
      plan_version: t.current_plan_version ?? 1,
      plan_hash: t.plans[String(t.current_plan_version)]?.plan_hash,
      item: "W1",
      expected_epoch: epoch,
    },
  }) as EventOf<"lease.claimed">;
}

function claim(builder: LogBuilder, state: State, taskId = T1): State {
  return applyEntry(state, builder.appendRaw(claimEvent(builder, state, taskId)));
}

function barrier(t: TaskState, closed = false): void {
  t.barrier = {
    id: "B5",
    opened_seq: 5,
    closed_seq: closed ? 5 : null,
    requests: [],
    awaiting: ["W1"],
    checkpointed: [],
    escalate: false,
  };
}

function delivered(epoch = 1): PayloadOf<"work.delivered"> {
  return {
    item: "W1",
    epoch,
    branch: workBranch(T1, "W1", epoch),
    head_sha: fakeSha("delivered"),
    pr_url: "https://example.invalid/pull/1",
    pr_number: 1,
    check_runs: [],
  };
}

describe("lease.claimed", () => {
  it("grants epoch 1 with the active plan, branch, sequence and attempt count", () => {
    const { builder, state } = executing();
    const after = claim(builder, state);
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(after)).toMatchObject({
      epochs: { W1: 1 },
      rev: 4,
      last_seq: after.seq,
      items: {
        W1: {
          status: "leased",
          attempts_this_plan: 1,
          lease: {
            epoch: 1,
            holder: VPS,
            attempt_id: "att_test",
            branch: `skep/${T1}/W1/e1`,
            plan_version: 1,
            plan_hash: task(state).plans["1"]?.plan_hash,
            granted_at_seq: after.seq,
            interrupt: null,
          },
        },
      },
    });
    expect(task(state).items.W1?.lease).toBeNull();
  });

  it.each([
    ["barrier_open", (t: TaskState) => barrier(t)],
    [
      "item_not_ready",
      (t: TaskState) => {
        if (t.items.W1) t.items.W1.status = "blocked";
      },
    ],
    [
      "not_assignee",
      (t: TaskState) => {
        if (t.items.W1) t.items.W1.assignee = MAC;
      },
    ],
    [
      "retry_budget",
      (t: TaskState) => {
        if (t.items.W1) t.items.W1.attempts_this_plan = 2;
      },
    ],
    [
      "bad_task_state",
      (t: TaskState) => {
        t.status = "interrupting";
      },
    ],
  ] as const)("rejects %s without changing domain state", (reason, change) => {
    const { builder, state } = executing();
    change(task(state));
    const before = canonicalJson(state);
    const event = claimEvent(builder, state);
    const after = applyEntry(state, builder.appendRaw(event));
    expect(after.outcomes.at(-1)).toMatchObject({ outcome: "rejected", reason });
    expect(after.tasks).toEqual(state.tasks);
    expect(after.agents).toEqual(state.agents);
    expect(after.seen_event_ids[event.event_id]).toBe(after.seq);
    expect(canonicalJson(state)).toBe(before);
  });

  it.each(["epoch_mismatch", "plan_changed", "bad_branch"] as const)(
    "rejects a claim with %s and retains all task fields",
    (reason) => {
      const { builder, state } = executing();
      const event = claimEvent(builder, state);
      if (reason === "epoch_mismatch") event.pre.expected_epoch = 1;
      if (reason === "plan_changed") event.pre.plan_hash = `sha256:${"a".repeat(64)}`;
      if (reason === "bad_branch") event.payload.branch = workBranch(T1, "W1", 2);
      const after = applyEntry(state, builder.appendRaw(event));
      expect(after.outcomes.at(-1)).toMatchObject({ outcome: "rejected", reason });
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it("checks the active plan hash even when current-plan preconditions match", () => {
    const { builder, state } = executing();
    task(state).active_plan_version = null;
    const after = claim(builder, state);
    expect(after.outcomes.at(-1)?.reason).toBe("plan_changed");
    expect(after.tasks).toEqual(state.tasks);
  });

  it("enforces max_parallel across a second task and allows the next claim after release", () => {
    const { builder } = executing();
    addTask(builder, T2);
    let state = claim(builder, replay(builder.entries), T2);
    expect(task(state, T2).items.W1?.lease?.holder).toBe(VPS);
    const before = state;
    state = claim(builder, state);
    expect(state.outcomes.at(-1)?.reason).toBe("max_parallel");
    expect(state.tasks).toEqual(before.tasks);
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "lease.released",
          task_id: T2,
          actor: VPS,
          payload: { item: "W1", epoch: 1, reason: "Free capacity" },
          pre: { task_rev: task(state, T2).rev, item: "W1" },
        }),
      ),
    );
    state = claim(builder, state);
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(state).toEqual(replay(builder.entries));
  });

  it("accepts leases in two tasks up to the configured parallel limit", () => {
    const { builder } = executing(2);
    addTask(builder, T2);
    let state = claim(builder, replay(builder.entries), T2);
    state = claim(builder, state);
    expect(state.outcomes.slice(-2).map((o) => o.outcome)).toEqual(["accepted", "accepted"]);
  });

  it("rejects the second of two claims computed from one state with an updated observed tip", () => {
    const { builder, state } = executing();
    const first = claimEvent(builder, state);
    const second = claimEvent(builder, state);
    builder.appendRaw(first);
    const claimed = replay(builder.entries);
    second.observed_tip = builder.tip;
    second.pre.task_rev = task(claimed).rev;
    builder.appendRaw(second);
    const after = replay(builder.entries);
    expect(after.outcomes.slice(-2).map((o) => o.outcome)).toEqual(["accepted", "rejected"]);
    expect(after.outcomes.at(-1)?.reason).toBe("epoch_mismatch");
    expect(after.tasks).toEqual(claimed.tasks);
  });

  it("preserves the specified handler rejection order", () => {
    const { builder, state } = executing();
    const t = task(state);
    const item = t.items.W1;
    if (!item) throw new Error("fixture item missing");
    barrier(t);
    item.status = "blocked";
    item.assignee = MAC;
    const event = claimEvent(builder, state);
    event.pre.expected_epoch = 1;
    event.pre.plan_hash = `sha256:${"a".repeat(64)}`;
    event.payload.branch = "wrong";
    item.attempts_this_plan = 2;
    const ctx = { seq: 6, sha: builder.tip, principal: { kind: "daemon", device: "vps" } } as const;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "barrier_open" });
    t.barrier = null;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "item_not_ready" });
    item.status = "ready";
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "not_assignee" });
    item.assignee = VPS;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "epoch_mismatch" });
    event.pre.expected_epoch = 0;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "plan_changed" });
    event.pre.plan_hash = t.plans["1"]?.plan_hash;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "retry_budget" });
    item.attempts_this_plan = 0;
    expect(handleLeaseClaimed(state, event, ctx)).toMatchObject({ reason: "bad_branch" });
  });
});

describe("lease release and revocation", () => {
  it("releases a lease while preserving its epoch and attempt count", () => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    const after = applyEntry(
      state,
      fixture.builder.appendRaw(
        fixture.builder.event({
          type: "lease.released",
          actor: VPS,
          payload: { item: "W1", epoch: 1, reason: "Yield" },
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(after)).toMatchObject({
      status: "executing",
      epochs: { W1: 1 },
      items: { W1: { status: "ready", lease: null, attempts_this_plan: 1 } },
    });
  });

  it.each(["absent", "wrong_holder", "wrong_epoch"] as const)(
    "fences release with %s lease",
    (kind) => {
      const fixture = executing();
      const state = kind === "absent" ? fixture.state : claim(fixture.builder, fixture.state);
      const after = applyEntry(
        state,
        fixture.builder.appendRaw(
          fixture.builder.event({
            type: "lease.released",
            actor: kind === "wrong_holder" ? MAC : VPS,
            payload: { item: "W1", epoch: kind === "wrong_epoch" ? 2 : 1, reason: "Yield" },
            pre: { task_rev: task(state).rev, item: "W1" },
          }),
        ),
      );
      expect(after.outcomes.at(-1)?.reason).toBe("fenced");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it.each(["absent", "wrong_epoch"] as const)("rejects revocation with %s lease", (kind) => {
    const fixture = executing();
    const state = kind === "absent" ? fixture.state : claim(fixture.builder, fixture.state);
    const after = applyEntry(
      state,
      fixture.builder.appendRaw(
        fixture.builder.event({
          type: "lease.revoked",
          actor: "human",
          payload: {
            item: "W1",
            epoch: kind === "wrong_epoch" ? 2 : 1,
            reason: "Revoke",
            observed_hb: null,
          },
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    expect(after.outcomes.at(-1)?.reason).toBe("epoch_mismatch");
    expect(after.tasks).toEqual(state.tasks);
  });

  it.each(["executing", "interrupting", "escalated"] as const)(
    "revokes a lease in %s",
    (status) => {
      const fixture = executing();
      const state = claim(fixture.builder, fixture.state);
      task(state).status = status;
      if (status === "interrupting") barrier(task(state));
      const after = applyEntry(
        state,
        fixture.builder.appendRaw(
          fixture.builder.event({
            type: "lease.revoked",
            actor: "human",
            payload: { item: "W1", epoch: 1, reason: "Revoke", observed_hb: null },
            pre: { task_rev: task(state).rev, item: "W1" },
          }),
        ),
      );
      expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
      expect(task(after).items.W1).toMatchObject({
        status: status === "interrupting" ? "unknown" : "ready",
        lease: null,
      });
      expect(task(after).epochs.W1).toBe(1);
      if (status === "interrupting") {
        expect(task(after).status).toBe("replanning");
        expect(task(after).barrier?.closed_seq).toBe(after.seq);
      }
    },
  );

  it("fences stale delivery after revocation and after a fresh epoch-2 lease", () => {
    const { builder, state: ready } = executing();
    let state = claim(builder, ready);
    builder.append({
      type: "lease.revoked",
      actor: "human",
      payload: { item: "W1", epoch: 1, reason: "Revoke", observed_hb: null },
      pre: { task_rev: task(state).rev, item: "W1" },
    });
    state = replay(builder.entries);
    expect(task(state).items.W1?.lease).toBeNull();
    builder.append({
      type: "work.delivered",
      actor: VPS,
      payload: delivered(),
      pre: { task_rev: task(state).rev, item: "W1" },
    });
    state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("fenced");
    state = claim(builder, state);
    expect(task(state).items.W1?.lease).toMatchObject({ epoch: 2, branch: `skep/${T1}/W1/e2` });
    builder.append({
      type: "work.delivered",
      actor: VPS,
      payload: delivered(),
      pre: { task_rev: task(state).rev, item: "W1" },
    });
    state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.reason).toBe("fenced");
    builder.append({
      type: "work.delivered",
      actor: VPS,
      payload: delivered(2),
      pre: { task_rev: task(state).rev, item: "W1" },
    });
    state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state)).toMatchObject({ status: "delivered", epochs: { W1: 2 } });
  });

  it("accepts delivery by a reassigned holder at epoch 2 under the next approved plan", () => {
    const { builder, state: ready } = executing();
    let state = claim(builder, ready);
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "lease.revoked",
          actor: "human",
          payload: { item: "W1", epoch: 1, reason: "Reassign work", observed_hb: null },
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "work.delivered",
          actor: VPS,
          payload: delivered(),
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    expect(state.outcomes.at(-1)?.reason).toBe("fenced");
    // SK-202 owns replan events; construct its barrier after the revoked holder has settled.
    task(state).status = "interrupting";
    barrier(task(state));
    settleBarrier(task(state), state.seq);
    expect(task(state).status).toBe("replanning");
    const plan = samplePlan({ version: 2, parent_version: 1 });
    plan.base.repo = REPO;
    const item = plan.items[0];
    if (!item) throw new Error("fixture plan item missing");
    item.assignee = MAC;
    const proposal = planProposed(plan);
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "plan.proposed",
          actor: VPS,
          payload: proposal,
          pre: { task_rev: task(state).rev, owner_gen: 1 },
        }),
      ),
    );
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "plan.approved",
          actor: "human",
          payload: { plan_version: 2, plan_hash: proposal.plan_hash },
          pre: { task_rev: task(state).rev, plan_version: 2, plan_hash: proposal.plan_hash },
        }),
      ),
    );
    expect(task(state)).toMatchObject({ epochs: { W1: 1 }, barrier: null });
    const event = claimEvent(builder, state);
    event.actor = MAC;
    state = applyEntry(state, builder.appendRaw(event));
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state).items.W1?.lease).toMatchObject({
      holder: MAC,
      epoch: 2,
      branch: `skep/${T1}/W1/e2`,
      plan_version: 2,
    });
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "work.delivered",
          actor: VPS,
          payload: delivered(),
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    expect(state.outcomes.at(-1)?.reason).toBe("fenced");
    state = applyEntry(
      state,
      builder.appendRaw(
        builder.event({
          type: "work.delivered",
          actor: MAC,
          payload: delivered(2),
          pre: { task_rev: task(state).rev, item: "W1" },
        }),
      ),
    );
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state).status).toBe("delivered");
  });
});
