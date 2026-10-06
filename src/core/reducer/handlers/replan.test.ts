import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  type EventSpec,
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
import type { EventType, PayloadOf, SkepEvent } from "../../schemas/events.js";
import type { Plan } from "../../schemas/plan.js";
import { applyEntry, replay } from "../replay.js";
import type { ItemState, RejectReason, State, TaskState } from "../state.js";
import { activeLeaseCount } from "./lease.js";
import { handleBarrierClosed, handleCheckpointRecorded, handleReplanRequested } from "./replan.js";

const REPO = "https://example.invalid/code.git";

interface Fixture {
  builder: LogBuilder;
  state: State;
}

function task(fixture: Fixture, id = T1): TaskState {
  const result = fixture.state.tasks[id];
  if (!result) throw new Error(`Fixture task ${id} missing`);
  return result;
}

function item(fixture: Fixture, id = "W1", taskId = T1): ItemState {
  const result = task(fixture, taskId).items[id];
  if (!result) throw new Error(`Fixture item ${id} missing`);
  return result;
}

function append<T extends EventType>(fixture: Fixture, spec: EventSpec<T>): SkepEvent {
  const current = fixture.state.tasks[spec.task_id ?? T1];
  const event = fixture.builder.append({
    ...spec,
    pre: { ...(current ? { task_rev: current.rev } : {}), ...spec.pre },
  });
  const entry = fixture.builder.entries.at(-1);
  if (!entry) throw new Error("Fixture entry missing");
  const before = fixture.state;
  const json = canonicalJson(before);
  fixture.state = applyEntry(before, entry);
  expect(canonicalJson(before)).toBe(json);
  return event;
}

function accepted(fixture: Fixture): void {
  expect(fixture.state.outcomes.at(-1)).toMatchObject({ outcome: "accepted", reason: null });
}

function reject<T extends EventType>(
  fixture: Fixture,
  spec: EventSpec<T>,
  reason: RejectReason,
): void {
  const before = structuredClone(fixture.state);
  const event = append(fixture, spec);
  const outcome = fixture.state.outcomes.at(-1);
  expect(outcome).toMatchObject({ outcome: "rejected", reason, event_id: event.event_id });
  expect(fixture.state).toEqual({
    ...before,
    tip: fixture.builder.tip,
    seq: before.seq + 1,
    seen_event_ids:
      reason === "unauthorized"
        ? before.seen_event_ids
        : { ...before.seen_event_ids, [event.event_id]: before.seq + 1 },
    outcomes: [...before.outcomes, outcome],
  });
}

function activate(fixture: Fixture, plan: Plan): void {
  const proposal = planProposed(plan, plan.mode === "team" ? [MAC] : []);
  append(fixture, {
    type: "plan.proposed",
    task_id: plan.task_id,
    actor: VPS,
    payload: proposal,
    pre: { owner_gen: task(fixture, plan.task_id).owner_gen },
  });
  accepted(fixture);
  const pre = { plan_version: plan.version, plan_hash: proposal.plan_hash };
  if (plan.mode === "team") {
    append(fixture, {
      type: "review.submitted",
      task_id: plan.task_id,
      actor: MAC,
      payload: { ...pre, verdict: "approve", blockers: [], suggestions: [] },
      pre,
    });
    accepted(fixture);
    append(fixture, {
      type: "plan.locked",
      task_id: plan.task_id,
      actor: VPS,
      payload: { ...pre, overrides: [], missing_reviews: [] },
      pre: { ...pre, owner_gen: task(fixture, plan.task_id).owner_gen },
    });
    accepted(fixture);
  }
  append(fixture, {
    type: "plan.approved",
    task_id: plan.task_id,
    actor: "human",
    payload: pre,
    pre,
  });
  accepted(fixture);
}

function addTask(
  fixture: Fixture,
  taskId = T1,
  mode: "solo" | "team" = "solo",
  replans = 2,
  assignee = VPS,
): void {
  const created = taskCreated({ repo: REPO, mode });
  created.budgets.replans = replans;
  append(fixture, { type: "task.created", task_id: taskId, actor: "human", payload: created });
  accepted(fixture);
  const plan = samplePlan({ task_id: taskId, mode });
  plan.base.repo = REPO;
  const first = plan.items[0];
  if (!first) throw new Error("Fixture plan item missing");
  first.assignee = assignee;
  if (mode === "team") {
    plan.items = [
      { ...first, id: "W3", title: "Finish integration", depends_on: ["W2"] },
      first,
      { ...first, id: "W2", title: "Add settings", assignee: MAC, depends_on: ["W1"] },
    ];
    plan.stack_order = ["W1", "W2", "W3"];
  }
  activate(fixture, plan);
}

function executing(mode: "solo" | "team" = "solo", replans = 2, assignee = VPS): Fixture {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const fixture = { builder, state: replay(builder.entries) };
  addTask(fixture, T1, mode, replans, assignee);
  return fixture;
}

function claimSpec(fixture: Fixture, taskId = T1): EventSpec<"lease.claimed"> {
  const current = task(fixture, taskId);
  const epoch = current.epochs.W1 ?? 0;
  return {
    type: "lease.claimed",
    task_id: taskId,
    actor: item(fixture, "W1", taskId).assignee,
    payload: { item: "W1", attempt_id: "att_test", branch: workBranch(taskId, "W1", epoch + 1) },
    pre: {
      item: "W1",
      expected_epoch: epoch,
      plan_version: current.current_plan_version ?? 1,
      plan_hash: current.plans[String(current.current_plan_version)]?.plan_hash,
    },
  };
}

function claim(fixture: Fixture, taskId = T1): void {
  append(fixture, claimSpec(fixture, taskId));
  accepted(fixture);
}

function requestPayload(): PayloadOf<"replan.requested"> {
  return {
    summary: "The expected endpoint is unavailable",
    evidence: [
      {
        id: "ev_endpoint",
        type: "command_run",
        run_id: "run_test",
        argv_sha256: "a".repeat(64),
        sha: fakeSha("evidence"),
        exit: 1,
        log_sha256: "b".repeat(64),
      },
    ],
    item: "W1",
  };
}

function request(fixture: Fixture, actor = VPS): SkepEvent {
  const event = append(fixture, { type: "replan.requested", actor, payload: requestPayload() });
  accepted(fixture);
  return event;
}

function checkpointPayload(
  fixture: Fixture,
  barrierId: string | null = task(fixture).barrier?.id ?? null,
  id = "W1",
): PayloadOf<"checkpoint.recorded"> {
  const lease = item(fixture, id).lease;
  if (!lease) throw new Error("Fixture lease missing");
  return {
    item: id,
    epoch: lease.epoch,
    barrier_id: barrierId,
    snapshot: {
      schema: "skep.snapshot/v1",
      item: id,
      epoch: lease.epoch,
      attempt_id: lease.attempt_id,
      branch: lease.branch,
      base_sha: fakeSha("base"),
      head_sha: fakeSha("checkpoint"),
      pushed: true,
      invocation_state: "interrupted",
      diffstat: { files: 1, insertions: 2, deletions: 0 },
      files_changed: ["src/example.ts"],
      check_runs: [],
      agent_note: null,
    },
  };
}

function checkpoint(fixture: Fixture, id = "W1"): void {
  const lease = item(fixture, id).lease;
  if (!lease) throw new Error("Fixture lease missing");
  append(fixture, {
    type: "checkpoint.recorded",
    actor: lease.holder,
    payload: checkpointPayload(fixture, task(fixture).barrier?.id ?? null, id),
    pre: { item: id },
  });
  accepted(fixture);
}

function nextPlan(fixture: Fixture): void {
  const current = task(fixture);
  const record = current.plans[String(current.current_plan_version)];
  if (!record) throw new Error("Fixture plan missing");
  activate(fixture, {
    ...record.plan,
    version: record.version + 1,
    parent_version: record.version,
    changes_from_parent: "Use the available endpoint",
  });
}

function delivery(epoch = 1): PayloadOf<"work.delivered"> {
  return {
    item: "W1",
    epoch,
    branch: workBranch(T1, "W1", epoch),
    head_sha: fakeSha("delivery"),
    pr_url: "https://example.invalid/pull/1",
    pr_number: 1,
    check_runs: [],
  };
}

function multipleLeases(): Fixture {
  const fixture = executing("team");
  claim(fixture);
  const firstLease = item(fixture).lease;
  if (!firstLease) throw new Error("Fixture lease missing");
  // Construct multiple holders to exercise the barrier's collection rules independently of
  // the MVP linear stack's claim routing (ARCHITECTURE §5.5).
  for (const id of ["W2", "W3"]) {
    const current = item(fixture, id);
    current.status = "leased";
    current.lease = {
      ...firstLease,
      holder: current.assignee,
      branch: workBranch(T1, id, 1),
    };
    task(fixture).epochs[id] = 1;
  }
  return fixture;
}

describe("replan.requested", () => {
  it.each(["human", "owner", "holder"] as const)("opens a barrier for the %s", (kind) => {
    const fixture = executing("solo", 2, kind === "holder" ? MAC : VPS);
    claim(fixture);
    const actor = kind === "human" ? "human" : kind === "holder" ? MAC : VPS;
    const payload = requestPayload();
    if (kind === "human") payload.evidence = [];
    const event = append(fixture, { type: "replan.requested", actor, payload });
    accepted(fixture);
    expect(task(fixture)).toMatchObject({
      status: "interrupting",
      replan_count: 1,
      escalation: null,
      barrier: {
        id: `B${fixture.state.seq}`,
        opened_seq: fixture.state.seq,
        closed_seq: null,
        awaiting: ["W1"],
        checkpointed: [],
        escalate: false,
        requests: [
          {
            seq: fixture.state.seq,
            event_id: event.event_id,
            actor,
            summary: payload.summary,
            evidence_count: payload.evidence.length,
          },
        ],
      },
    });
    expect(item(fixture).lease?.interrupt).toBe(task(fixture).barrier?.id);
    expect(item(fixture).status).toBe("leased");
    expect(activeLeaseCount(fixture.state, actor)).toBe(kind === "human" ? 0 : 1);
    reject(fixture, claimSpec(fixture), "bad_task_state");
  });

  it("flags all leased items in stack order regardless of record order", () => {
    const fixture = multipleLeases();
    const current = task(fixture);
    current.items = { W3: item(fixture, "W3"), W2: item(fixture, "W2"), W1: item(fixture) };
    request(fixture);
    expect(task(fixture).barrier?.awaiting).toEqual(["W1", "W2", "W3"]);
    for (const currentItem of Object.values(task(fixture).items)) {
      expect(currentItem.lease?.interrupt).toBe(task(fixture).barrier?.id);
      expect(currentItem.status).toBe("leased");
    }
  });

  it("awaits only leased items and preserves ready and delivered items", () => {
    const fixture = multipleLeases();
    item(fixture, "W2").status = "ready";
    item(fixture, "W2").lease = null;
    item(fixture, "W3").status = "delivered";
    item(fixture, "W3").lease = null;
    const before = structuredClone(task(fixture).items);
    request(fixture);
    expect(task(fixture).barrier?.awaiting).toEqual(["W1"]);
    expect(item(fixture, "W2")).toEqual(before.W2);
    expect(item(fixture, "W3")).toEqual(before.W3);
  });

  it.each([2, 0])("settles an empty barrier immediately with budget %s", (budget) => {
    const fixture = executing("solo", budget);
    append(fixture, {
      type: "replan.requested",
      actor: "human",
      payload: { ...requestPayload(), evidence: [], item: null },
    });
    accepted(fixture);
    expect(task(fixture).barrier).toMatchObject({
      awaiting: [],
      checkpointed: [],
      opened_seq: fixture.state.seq,
      closed_seq: fixture.state.seq,
      escalate: budget === 0,
    });
    expect(task(fixture).status).toBe(budget === 0 ? "escalated" : "replanning");
    expect(task(fixture).escalation).toEqual(
      budget === 0 ? { reason: "replans", seq: fixture.state.seq } : null,
    );
  });

  it.each(["interrupting", "replanning"] as const)(
    "coalesces in %s without consuming budget",
    (status) => {
      const fixture = executing();
      claim(fixture);
      request(fixture);
      if (status === "replanning") checkpoint(fixture);
      const before = structuredClone(task(fixture));
      const event = request(fixture, "human");
      expect(task(fixture)).toEqual({
        ...before,
        rev: before.rev + 1,
        last_seq: fixture.state.seq,
        barrier: {
          ...before.barrier,
          requests: [
            ...(before.barrier?.requests ?? []),
            {
              seq: fixture.state.seq,
              event_id: event.event_id,
              actor: "human",
              summary: requestPayload().summary,
              evidence_count: 1,
            },
          ],
        },
      });
    },
  );

  it.each(["executing", "interrupting", "replanning"] as const)(
    "requires daemon evidence in %s",
    (status) => {
      const fixture = executing();
      claim(fixture);
      if (status !== "executing") request(fixture);
      if (status === "replanning") checkpoint(fixture);
      reject(
        fixture,
        {
          type: "replan.requested",
          actor: VPS,
          payload: { ...requestPayload(), evidence: [], item: "W9" },
        },
        "missing_evidence",
      );
    },
  );

  it("rejects a non-null unknown item after checking evidence", () => {
    const fixture = executing();
    reject(
      fixture,
      {
        type: "replan.requested",
        actor: VPS,
        payload: { ...requestPayload(), item: "W9" },
      },
      "unknown_item",
    );
  });

  it.each(["planning", "reviewing", "awaiting_approval", "delivered", "escalated"] as const)(
    "rejects %s before checking evidence or item",
    (status) => {
      const fixture = executing();
      task(fixture).status = status;
      reject(
        fixture,
        {
          type: "replan.requested",
          actor: VPS,
          payload: { ...requestPayload(), evidence: [], item: "W9" },
        },
        "bad_task_state",
      );
    },
  );

  it("rejects requests from agents who are neither owner nor holder", () => {
    const fixture = executing();
    reject(
      fixture,
      { type: "replan.requested", actor: MAC, payload: requestPayload() },
      "unauthorized",
    );
  });

  it("uses the signer principal for the evidence exemption", () => {
    const fixture = executing();
    const event = fixture.builder.event({
      type: "replan.requested",
      actor: "human",
      payload: { ...requestPayload(), evidence: [] },
    }) as Parameters<typeof handleReplanRequested>[1];
    const before = canonicalJson(fixture.state);
    expect(
      handleReplanRequested(fixture.state, event, {
        seq: fixture.state.seq + 1,
        sha: fixture.builder.tip,
        principal: { kind: "daemon", device: "vps" },
      }),
    ).toEqual({ ok: false, reason: "missing_evidence" });
    expect(canonicalJson(fixture.state)).toBe(before);
  });
});

describe("checkpoint.recorded", () => {
  it.each(["executing", "interrupting", "replanning", "escalated"] as const)(
    "records a voluntary checkpoint without changing lease or status in %s",
    (status) => {
      const fixture = executing();
      claim(fixture);
      if (status !== "executing") request(fixture);
      if (status === "replanning" || status === "escalated") checkpoint(fixture);
      task(fixture).status = status;
      const before = structuredClone(task(fixture));
      const payload = checkpointPayload(fixture, null);
      payload.snapshot.head_sha = null;
      payload.snapshot.invocation_state = "unknown";
      append(fixture, { type: "checkpoint.recorded", actor: VPS, payload, pre: { item: "W1" } });
      accepted(fixture);
      expect(task(fixture)).toEqual({
        ...before,
        rev: before.rev + 1,
        last_seq: fixture.state.seq,
        items: {
          ...before.items,
          W1: {
            ...before.items.W1,
            last_checkpoint: {
              epoch: 1,
              seq: fixture.state.seq,
              barrier_id: null,
              head_sha: null,
              invocation_state: "unknown",
            },
          },
        },
      });
    },
  );

  it("does not settle or free capacity for a voluntary checkpoint during interruption", () => {
    const fixture = executing();
    claim(fixture);
    request(fixture);
    append(fixture, {
      type: "checkpoint.recorded",
      actor: VPS,
      payload: checkpointPayload(fixture, null),
      pre: { item: "W1" },
    });
    accepted(fixture);
    expect(task(fixture).status).toBe("interrupting");
    expect(task(fixture).barrier?.checkpointed).toEqual([]);
    expect(task(fixture).barrier?.closed_seq).toBeNull();
    expect(item(fixture).status).toBe("leased");
    expect(activeLeaseCount(fixture.state, VPS)).toBe(1);
  });

  it("parks the lease, settles the barrier and accepts late checkpoints without duplicates", () => {
    const fixture = executing();
    claim(fixture);
    request(fixture);
    const lease = structuredClone(item(fixture).lease);
    checkpoint(fixture);
    const closedSeq = fixture.state.seq;
    expect(item(fixture)).toMatchObject({
      status: "interrupted",
      lease,
      last_checkpoint: {
        epoch: 1,
        seq: closedSeq,
        barrier_id: task(fixture).barrier?.id,
        head_sha: fakeSha("checkpoint"),
        invocation_state: "interrupted",
      },
    });
    expect(task(fixture).status).toBe("replanning");
    checkpoint(fixture);
    expect(task(fixture).barrier?.checkpointed).toEqual(["W1"]);
    expect(task(fixture).barrier?.closed_seq).toBe(closedSeq);
    expect(item(fixture).last_checkpoint?.seq).toBe(fixture.state.seq);
    expect(item(fixture).lease).toEqual(lease);
    expect(fixture.state).toEqual(replay(fixture.builder.entries));
  });

  it.each(["lease", "holder", "epoch"] as const)(
    "rejects a fenced %s before snapshot validation",
    (field) => {
      const fixture = executing();
      claim(fixture);
      const payload = checkpointPayload(fixture, "B999");
      payload.snapshot.item = "W9";
      if (field === "lease") item(fixture).lease = null;
      if (field === "epoch") payload.epoch = 2;
      reject(
        fixture,
        {
          type: "checkpoint.recorded",
          actor: field === "holder" ? MAC : VPS,
          payload,
          pre: { item: "W1" },
        },
        "fenced",
      );
    },
  );

  it.each(["item", "epoch"] as const)(
    "rejects a mismatched snapshot %s before barrier validation",
    (field) => {
      const fixture = executing();
      claim(fixture);
      const payload = checkpointPayload(fixture, "B999");
      if (field === "item") payload.snapshot.item = "W9";
      else payload.snapshot.epoch = 2;
      reject(
        fixture,
        { type: "checkpoint.recorded", actor: VPS, payload, pre: { item: "W1" } },
        "bad_snapshot",
      );
    },
  );

  it.each([false, true])("rejects a missing or different barrier (exists=%s)", (exists) => {
    const fixture = executing();
    claim(fixture);
    if (exists) request(fixture);
    reject(
      fixture,
      {
        type: "checkpoint.recorded",
        actor: VPS,
        payload: checkpointPayload(fixture, "B999"),
        pre: { item: "W1" },
      },
      "no_barrier",
    );
  });

  it.each(["planning", "reviewing", "awaiting_approval", "delivered"] as const)(
    "rejects checkpoints in %s",
    (status) => {
      const fixture = executing();
      claim(fixture);
      const payload = checkpointPayload(fixture);
      task(fixture).status = status;
      item(fixture).lease = null;
      reject(
        fixture,
        { type: "checkpoint.recorded", actor: VPS, payload, pre: { item: "W1" } },
        "bad_task_state",
      );
    },
  );

  it("rejects an unknown checkpoint item without changing task state", () => {
    const fixture = executing();
    claim(fixture);
    const payload = checkpointPayload(fixture);
    payload.item = "W9";
    reject(
      fixture,
      { type: "checkpoint.recorded", actor: VPS, payload, pre: { item: "W1" } },
      "unknown_item",
    );
  });
});

describe("barrier.closed", () => {
  it.each(["human", VPS])(
    "allows %s to close with the exact unsettled items in any order",
    (actor) => {
      const fixture = multipleLeases();
      request(fixture);
      checkpoint(fixture, "W2");
      expect(task(fixture).status).toBe("interrupting");
      const parked = structuredClone(item(fixture, "W2"));
      const epochs = structuredClone(task(fixture).epochs);
      const late = checkpointPayload(fixture);
      append(fixture, {
        type: "barrier.closed",
        actor,
        payload: { barrier_id: task(fixture).barrier?.id ?? "B999", missing: ["W3", "W1"] },
      });
      accepted(fixture);
      expect(task(fixture).status).toBe("replanning");
      expect(task(fixture).barrier?.closed_seq).toBe(fixture.state.seq);
      expect(task(fixture).epochs).toEqual(epochs);
      expect(item(fixture, "W2")).toEqual(parked);
      for (const id of ["W1", "W3"])
        expect(item(fixture, id)).toMatchObject({ status: "unknown", lease: null });
      reject(
        fixture,
        { type: "checkpoint.recorded", actor: VPS, payload: late, pre: { item: "W1" } },
        "fenced",
      );
    },
  );

  it("excludes checkpointed and lease-cleared items from the required missing list", () => {
    const fixture = multipleLeases();
    request(fixture);
    checkpoint(fixture);
    append(fixture, {
      type: "lease.released",
      actor: MAC,
      payload: { item: "W2", epoch: 1, reason: "Stopped work" },
      pre: { item: "W2" },
    });
    accepted(fixture);
    append(fixture, {
      type: "barrier.closed",
      actor: VPS,
      payload: { barrier_id: task(fixture).barrier?.id ?? "B999", missing: ["W3"] },
    });
    accepted(fixture);
    expect(task(fixture).status).toBe("replanning");
    expect(item(fixture).status).toBe("interrupted");
    expect(item(fixture, "W2").status).toBe("ready");
    expect(item(fixture, "W3").status).toBe("unknown");
  });

  it.each([
    { missing: [] },
    { missing: ["W1"] },
    { missing: ["W1", "W1", "W3"] },
    { missing: ["W1", "W2", "W3"] },
    { missing: ["W1", "W3", "W9"] },
  ])("rejects an inexact missing list $missing without mutating state", ({ missing }) => {
    const fixture = multipleLeases();
    request(fixture);
    checkpoint(fixture, "W2");
    reject(
      fixture,
      {
        type: "barrier.closed",
        actor: "human",
        payload: { barrier_id: task(fixture).barrier?.id ?? "B999", missing },
      },
      "pre_mismatch",
    );
  });

  it.each(["missing", "different", "closed"] as const)(
    "rejects a %s barrier before missing-list checks",
    (kind) => {
      const fixture = executing();
      claim(fixture);
      request(fixture);
      const barrier = task(fixture).barrier;
      if (!barrier) throw new Error("Fixture barrier missing");
      if (kind === "missing") task(fixture).barrier = null;
      if (kind === "closed") barrier.closed_seq = fixture.state.seq;
      reject(
        fixture,
        {
          type: "barrier.closed",
          actor: "human",
          payload: { barrier_id: kind === "different" ? "B999" : barrier.id, missing: [] },
        },
        "no_barrier",
      );
    },
  );

  it.each([
    "planning",
    "reviewing",
    "awaiting_approval",
    "executing",
    "replanning",
    "delivered",
    "escalated",
  ] as const)("rejects barrier closure in %s before checking the barrier", (status) => {
    const fixture = executing();
    task(fixture).status = status;
    reject(
      fixture,
      {
        type: "barrier.closed",
        actor: "human",
        payload: { barrier_id: "B999", missing: [] },
      },
      "bad_task_state",
    );
  });

  it("rejects closure by a holder who is not the owner", () => {
    const fixture = executing("solo", 2, MAC);
    claim(fixture);
    request(fixture, MAC);
    reject(
      fixture,
      {
        type: "barrier.closed",
        actor: MAC,
        payload: { barrier_id: task(fixture).barrier?.id ?? "B999", missing: ["W1"] },
      },
      "unauthorized",
    );
  });

  it("escalates an exhausted barrier when its last missing lease is cleared", () => {
    const fixture = executing("solo", 0);
    claim(fixture);
    request(fixture);
    expect(task(fixture).status).toBe("interrupting");
    expect(task(fixture).escalation).toBeNull();
    append(fixture, {
      type: "barrier.closed",
      actor: "human",
      payload: { barrier_id: task(fixture).barrier?.id ?? "B999", missing: ["W1"] },
    });
    accepted(fixture);
    expect(task(fixture)).toMatchObject({
      status: "escalated",
      escalation: { reason: "replans", seq: fixture.state.seq },
      barrier: { closed_seq: fixture.state.seq },
    });
    expect(item(fixture)).toMatchObject({ status: "unknown", lease: null });
  });
});

describe("replan lifecycles", () => {
  it.each(["solo", "team"] as const)(
    "resumes a %s plan with a higher epoch and fences stale delivery",
    (mode) => {
      const fixture = executing(mode);
      claim(fixture);
      request(fixture);
      checkpoint(fixture);
      expect(task(fixture).status).toBe("replanning");
      const epochs = structuredClone(task(fixture).epochs);
      nextPlan(fixture);
      expect(task(fixture)).toMatchObject({
        status: "executing",
        barrier: null,
        active_plan_version: 2,
        epochs,
        escalation: null,
      });
      expect(item(fixture)).toMatchObject({ status: "ready", lease: null, attempts_this_plan: 0 });
      reject(
        fixture,
        {
          type: "work.delivered",
          actor: VPS,
          payload: delivery(),
          pre: { item: "W1" },
        },
        "fenced",
      );
      claim(fixture);
      expect(item(fixture).lease).toMatchObject({ epoch: 2, interrupt: null, plan_version: 2 });
      reject(
        fixture,
        {
          type: "work.delivered",
          actor: VPS,
          payload: delivery(),
          pre: { item: "W1" },
        },
        "fenced",
      );
      append(fixture, {
        type: "work.delivered",
        actor: VPS,
        payload: delivery(2),
        pre: { item: "W1" },
      });
      accepted(fixture);
      const expected = canonicalJson(fixture.state);
      expect(canonicalJson(replay(fixture.builder.entries))).toBe(expected);
      for (let prefix = 1; prefix <= fixture.builder.entries.length; prefix++) {
        const initial = replay(fixture.builder.entries.slice(0, prefix));
        expect(
          canonicalJson(fixture.builder.entries.slice(prefix).reduce(applyEntry, initial)),
        ).toBe(expected);
      }
    },
  );

  it("escalates only after the third barrier settles, then clears it at the human gate (D12)", () => {
    const fixture = executing();
    for (let count = 1; count <= 3; count++) {
      claim(fixture);
      request(fixture);
      expect(task(fixture).status).toBe("interrupting");
      expect(task(fixture).replan_count).toBe(count);
      expect(task(fixture).barrier?.escalate).toBe(count === 3);
      expect(task(fixture).escalation).toBeNull();
      request(fixture);
      expect(task(fixture).replan_count).toBe(count);
      checkpoint(fixture);
      expect(task(fixture).status).toBe(count === 3 ? "escalated" : "replanning");
      if (count < 3) {
        request(fixture);
        expect(task(fixture).replan_count).toBe(count);
        nextPlan(fixture);
      }
    }
    expect(task(fixture).escalation).toEqual({ reason: "replans", seq: fixture.state.seq });
    const closedSeq = fixture.state.seq;
    checkpoint(fixture);
    expect(task(fixture).status).toBe("escalated");
    expect(task(fixture).barrier?.closed_seq).toBe(closedSeq);
    expect(task(fixture).barrier?.checkpointed).toEqual(["W1"]);
    reject(
      fixture,
      { type: "replan.requested", actor: VPS, payload: requestPayload() },
      "bad_task_state",
    );
    append(fixture, { type: "human.decided", actor: "human", payload: { decision: "replan" } });
    accepted(fixture);
    expect(task(fixture)).toMatchObject({
      status: "planning",
      barrier: null,
      escalation: null,
      review_rounds: 0,
      replan_count: 3,
      epochs: { W1: 3 },
    });
    nextPlan(fixture);
    expect(item(fixture).lease).toBeNull();
    request(fixture);
    expect(task(fixture)).toMatchObject({ status: "escalated", replan_count: 4 });
    expect(fixture.state).toEqual(replay(fixture.builder.entries));
  });

  it.each(["lease.released", "lease.revoked", "work.failed"] as const)(
    "settles the barrier when %s clears its last lease",
    (type) => {
      const fixture = executing();
      claim(fixture);
      request(fixture);
      if (type === "lease.released") {
        append(fixture, {
          type,
          actor: VPS,
          payload: { item: "W1", epoch: 1, reason: "Stopped" },
          pre: { item: "W1" },
        });
      } else if (type === "lease.revoked") {
        append(fixture, {
          type,
          actor: "human",
          payload: { item: "W1", epoch: 1, reason: "Holder unavailable", observed_hb: null },
          pre: { item: "W1" },
        });
      } else {
        append(fixture, {
          type,
          actor: VPS,
          payload: { item: "W1", epoch: 1, class: "crash", detail: "Invocation stopped" },
          pre: { item: "W1" },
        });
      }
      accepted(fixture);
      expect(task(fixture).status).toBe("replanning");
      expect(task(fixture).barrier).toMatchObject({
        checkpointed: [],
        closed_seq: fixture.state.seq,
      });
      expect(item(fixture).lease).toBeNull();
      expect(fixture.state).toEqual(replay(fixture.builder.entries));
    },
  );

  it.each([2, 0])(
    "frees cross-task capacity only after the barrier checkpoint (D16, budget=%s)",
    (budget) => {
      const fixture = executing("solo", budget);
      addTask(fixture, T2);
      claim(fixture);
      request(fixture);
      expect(activeLeaseCount(fixture.state, VPS)).toBe(1);
      reject(fixture, claimSpec(fixture, T2), "max_parallel");
      const parked = structuredClone(item(fixture).lease);
      checkpoint(fixture);
      expect(task(fixture).status).toBe(budget === 0 ? "escalated" : "replanning");
      expect(item(fixture)).toMatchObject({ status: "interrupted", lease: parked });
      expect(activeLeaseCount(fixture.state, VPS)).toBe(0);
      claim(fixture, T2);
      expect(item(fixture, "W1", T2).status).toBe("leased");
      expect(activeLeaseCount(fixture.state, VPS)).toBe(1);
      expect(item(fixture).lease).toEqual(parked);
      expect(fixture.state).toEqual(replay(fixture.builder.entries));
    },
  );
});

describe("replan handler guards", () => {
  it.each([handleReplanRequested, handleCheckpointRecorded, handleBarrierClosed])(
    "rejects a missing task before accessing its payload",
    (handler) => {
      const fixture = executing();
      const event = fixture.builder.event({
        type: "task.cancelled",
        task_id: T2,
        actor: "human",
        payload: { reason: "Cancel" },
      });
      const before = canonicalJson(fixture.state);
      expect(
        handler(fixture.state, event as never, {
          seq: fixture.state.seq + 1,
          sha: fixture.builder.tip,
          principal: { kind: "human" },
        }),
      ).toEqual({ ok: false, reason: "unknown_task" });
      expect(canonicalJson(fixture.state)).toBe(before);
    },
  );

  it.each(["done", "cancelled"] as const)(
    "rejects every replan event for a terminal %s task",
    (status) => {
      const fixture = executing();
      claim(fixture);
      const payload = checkpointPayload(fixture);
      task(fixture).status = status;
      reject(
        fixture,
        { type: "replan.requested", actor: "human", payload: requestPayload() },
        "task_terminal",
      );
      reject(
        fixture,
        { type: "checkpoint.recorded", actor: VPS, payload, pre: { item: "W1" } },
        "task_terminal",
      );
      reject(
        fixture,
        { type: "barrier.closed", actor: "human", payload: { barrier_id: "B999", missing: [] } },
        "task_terminal",
      );
    },
  );

  it.each(["interrupting", "replanning"] as const)(
    "rejects a missing coalescing barrier in %s without mutation",
    (status) => {
      const fixture = executing();
      task(fixture).status = status;
      reject(
        fixture,
        { type: "replan.requested", actor: VPS, payload: requestPayload() },
        "no_barrier",
      );
    },
  );

  it("rejects an executing task without an active plan before opening a barrier", () => {
    const fixture = executing();
    task(fixture).active_plan_version = null;
    reject(
      fixture,
      { type: "replan.requested", actor: VPS, payload: requestPayload() },
      "unknown_plan_version",
    );
  });
});
