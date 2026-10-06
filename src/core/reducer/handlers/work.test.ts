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
import { workBranch } from "../../ids.js";
import type { PayloadOf } from "../../schemas/events.js";
import { applyEntry, replay } from "../replay.js";
import type { State, TaskState } from "../state.js";

function task(state: State): TaskState {
  const result = state.tasks[T1];
  if (!result) throw new Error("fixture task missing");
  return result;
}

function executing(retries = 1): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const created = taskCreated({ repo: "https://example.invalid/code.git", mode: "team" });
  created.budgets.item_retries = retries;
  builder.append({ type: "task.created", actor: "human", payload: created });
  const plan = samplePlan({ mode: "team" });
  plan.base.repo = created.repo;
  const first = plan.items[0];
  if (!first) throw new Error("fixture plan item missing");
  plan.items = [
    first,
    { ...first, id: "W2", title: "Second change", assignee: MAC, depends_on: ["W1"] },
  ];
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
  return { builder, state: replay(builder.entries) };
}

function claim(builder: LogBuilder, state: State, id = "W1"): State {
  const t = task(state);
  const epoch = t.epochs[id] ?? 0;
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type: "lease.claimed",
        actor: t.items[id]?.assignee ?? VPS,
        payload: { item: id, attempt_id: "att_work", branch: workBranch(T1, id, epoch + 1) },
        pre: {
          task_rev: t.rev,
          plan_version: 1,
          plan_hash: t.plans["1"]?.plan_hash,
          item: id,
          expected_epoch: epoch,
        },
      }),
    ),
  );
}

function work<T extends "work.delivered" | "work.failed">(
  builder: LogBuilder,
  state: State,
  type: T,
  payload: PayloadOf<T>,
  actor = task(state).items[payload.item]?.assignee ?? VPS,
): State {
  return applyEntry(
    state,
    builder.appendRaw(
      builder.event({
        type,
        actor,
        payload,
        pre: { task_rev: task(state).rev, item: payload.item },
      }),
    ),
  );
}

function delivery(id = "W1", epoch = 1): PayloadOf<"work.delivered"> {
  const head = fakeSha(id);
  return {
    item: id,
    epoch,
    branch: workBranch(T1, id, epoch),
    head_sha: head,
    pr_url: `https://example.invalid/pull/${id === "W1" ? 1 : 2}`,
    pr_number: id === "W1" ? 1 : 2,
    check_runs: [
      {
        run_id: "run_unit",
        check: "unit",
        sha: head,
        exit: 0,
        duration_ms: 10,
        passed: 3,
        log_sha256: "a".repeat(64),
      },
    ],
  };
}

function failure(overrides: Partial<PayloadOf<"work.failed">> = {}): PayloadOf<"work.failed"> {
  return {
    item: "W1",
    epoch: 1,
    class: "checks_failed",
    detail: "Unit check failed",
    ...overrides,
  };
}

function interrupt(state: State, escalate: boolean): void {
  const t = task(state);
  const first = t.items.W1;
  const second = t.items.W2;
  if (!first?.lease || !second) throw new Error("fixture lease or item missing");
  second.lease = { ...first.lease, holder: MAC, branch: workBranch(T1, "W2", 1) };
  second.status = "leased";
  second.attempts_this_plan = 1;
  t.epochs.W2 = 1;
  t.status = "interrupting";
  t.barrier = {
    id: `B${state.seq}`,
    opened_seq: state.seq,
    closed_seq: null,
    requests: [],
    awaiting: ["W1", "W2"],
    checkpointed: [],
    escalate,
  };
  first.lease.interrupt = t.barrier.id;
  second.lease.interrupt = t.barrier.id;
}

describe("work.delivered", () => {
  it("records delivery, unblocks W2 and reaches delivered after the second item", () => {
    const { builder, state: ready } = executing();
    expect(task(ready).items.W2?.status).toBe("blocked");
    let state = claim(builder, ready);
    const payload = delivery();
    state = work(builder, state, "work.delivered", payload);
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state)).toMatchObject({
      status: "executing",
      items: {
        W1: { status: "delivered", lease: null, delivered: { epoch: 1, seq: state.seq } },
        W2: { status: "ready", lease: null, delivered: null },
      },
    });
    const { item: _item, ...record } = payload;
    expect(task(state).items.W1?.delivered).toEqual({ ...record, seq: state.seq });
    state = claim(builder, state, "W2");
    state = work(builder, state, "work.delivered", delivery("W2"));
    expect(task(state).status).toBe("delivered");
    expect(task(state).items.W2?.delivered?.head_sha).toBe(fakeSha("W2"));
    expect(replay(builder.entries)).toEqual(state);
  });

  it("rejects a second delivery for the same epoch", () => {
    const fixture = executing();
    const state = work(
      fixture.builder,
      claim(fixture.builder, fixture.state),
      "work.delivered",
      delivery(),
    );
    const after = work(fixture.builder, state, "work.delivered", delivery());
    expect(after.outcomes.at(-1)?.reason).toBe("fenced");
    expect(after.tasks).toEqual(state.tasks);
  });

  it.each(["wrong_holder", "wrong_epoch", "absent"] as const)(
    "fences delivery with %s lease",
    (kind) => {
      const fixture = executing();
      const state = kind === "absent" ? fixture.state : claim(fixture.builder, fixture.state);
      const after = work(
        fixture.builder,
        state,
        "work.delivered",
        delivery("W1", kind === "wrong_epoch" ? 2 : 1),
        kind === "wrong_holder" ? MAC : VPS,
      );
      expect(after.outcomes.at(-1)?.reason).toBe("fenced");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it.each(["interrupted", "bad_branch"] as const)("rejects %s delivery", (reason) => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    const payload = delivery();
    payload.branch = workBranch(T1, "W1", 2);
    if (reason === "interrupted") {
      const lease = task(state).items.W1?.lease;
      if (lease) lease.interrupt = "B7";
    }
    const after = work(fixture.builder, state, "work.delivered", payload);
    expect(after.outcomes.at(-1)?.reason).toBe(reason);
    expect(after.tasks).toEqual(state.tasks);
  });

  it("rejects delivery in interrupting before checking fencing or branch", () => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    interrupt(state, false);
    const after = work(fixture.builder, state, "work.delivered", delivery("W1", 2), MAC);
    expect(after.outcomes.at(-1)?.reason).toBe("bad_task_state");
    expect(after.tasks).toEqual(state.tasks);
  });

  it("leaves other leased items leased when their dependency is delivered", () => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    const second = task(state).items.W2;
    const lease = task(state).items.W1?.lease;
    if (!second || !lease) throw new Error("fixture item or lease missing");
    second.status = "leased";
    second.lease = { ...lease, holder: MAC, branch: workBranch(T1, "W2", 1) };
    const after = work(fixture.builder, state, "work.delivered", delivery());
    expect(task(after).items.W2).toEqual(second);
  });
});

describe("work.failed", () => {
  it("allows one retry and escalates the failure of that retry", () => {
    const { builder, state: ready } = executing(1);
    let state = claim(builder, ready);
    state = work(builder, state, "work.failed", failure());
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state)).toMatchObject({
      status: "executing",
      escalation: null,
      items: {
        W1: {
          status: "ready",
          lease: null,
          attempts_this_plan: 1,
          failure: { epoch: 1, seq: state.seq },
        },
      },
    });
    const { item: _item, ...record } = failure();
    expect(task(state).items.W1?.failure).toEqual({ ...record, seq: state.seq });
    state = claim(builder, state);
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(state).items.W1).toMatchObject({ attempts_this_plan: 2, lease: { epoch: 2 } });
    state = work(builder, state, "work.failed", failure({ epoch: 2 }));
    expect(task(state)).toMatchObject({
      status: "escalated",
      escalation: { reason: "item_failed", seq: state.seq },
      items: { W1: { status: "failed", lease: null, failure: { epoch: 2 } } },
    });
    expect(replay(builder.entries)).toEqual(state);
  });

  it.each([0, 1, 3])("escalates budget_exceeded immediately with %i retries allowed", (retries) => {
    const fixture = executing(retries);
    const state = claim(fixture.builder, fixture.state);
    const after = work(
      fixture.builder,
      state,
      "work.failed",
      failure({ class: "budget_exceeded" }),
    );
    expect(task(after)).toMatchObject({
      status: "escalated",
      escalation: { reason: "budget_exceeded", seq: after.seq },
      items: { W1: { status: "failed", lease: null } },
    });
  });

  it("escalates an ordinary first failure when no retries are allowed", () => {
    const fixture = executing(0);
    const state = claim(fixture.builder, fixture.state);
    const after = work(fixture.builder, state, "work.failed", failure());
    expect(task(after).escalation).toEqual({ reason: "item_failed", seq: after.seq });
  });

  it.each([
    "invalid_output",
    "checks_failed",
    "timeout",
    "permission_prompt",
    "crash",
    "preflight",
    "secret_detected",
  ] as const)("records %s and permits retry when budget remains", (failureClass) => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    const after = work(fixture.builder, state, "work.failed", failure({ class: failureClass }));
    expect(task(after).items.W1).toMatchObject({
      status: "ready",
      lease: null,
      failure: { class: failureClass, seq: after.seq },
    });
    expect(task(after).status).toBe("executing");
  });

  it.each(["wrong_holder", "wrong_epoch", "absent"] as const)(
    "fences failure with %s lease",
    (kind) => {
      const fixture = executing();
      const state = kind === "absent" ? fixture.state : claim(fixture.builder, fixture.state);
      const after = work(
        fixture.builder,
        state,
        "work.failed",
        failure({ epoch: kind === "wrong_epoch" ? 2 : 1 }),
        kind === "wrong_holder" ? MAC : VPS,
      );
      expect(after.outcomes.at(-1)?.reason).toBe("fenced");
      expect(after.tasks).toEqual(state.tasks);
    },
  );

  it.each([false, true])(
    "settles an interrupting barrier after release and failure (escalate=%s)",
    (escalate) => {
      const fixture = executing();
      let state = claim(fixture.builder, fixture.state);
      interrupt(state, escalate);
      state = applyEntry(
        state,
        fixture.builder.appendRaw(
          fixture.builder.event({
            type: "lease.released",
            actor: VPS,
            payload: { item: "W1", epoch: 1, reason: "Interrupted" },
            pre: { task_rev: task(state).rev, item: "W1" },
          }),
        ),
      );
      expect(task(state)).toMatchObject({
        status: "interrupting",
        barrier: { closed_seq: null },
        items: { W1: { status: "ready", lease: null } },
      });
      const after = work(fixture.builder, state, "work.failed", failure({ item: "W2" }), MAC);
      expect(after.outcomes.at(-1)?.outcome).toBe("accepted");
      expect(task(after)).toMatchObject({
        status: escalate ? "escalated" : "replanning",
        barrier: { closed_seq: after.seq },
        items: { W2: { status: "failed", lease: null } },
        escalation: escalate ? { reason: "replans", seq: after.seq } : null,
      });
    },
  );

  it("settles an interrupting budget failure using the barrier's replan budget", () => {
    const fixture = executing();
    const state = claim(fixture.builder, fixture.state);
    interrupt(state, false);
    const barrier = task(state).barrier;
    if (barrier) barrier.checkpointed = ["W2"];
    const after = work(
      fixture.builder,
      state,
      "work.failed",
      failure({ class: "budget_exceeded" }),
    );
    expect(task(after)).toMatchObject({
      status: "replanning",
      escalation: null,
      barrier: { closed_seq: after.seq },
    });
  });
});
