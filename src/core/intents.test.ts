import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  BASE_COMMIT,
  fakeEventId,
  fakeSha,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  T2,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { canonicalJson } from "./canonical.js";
import { workBranch } from "./ids.js";
import {
  checkpointIntent,
  claimCandidates,
  claimIntent,
  deliverIntent,
  draft,
  type EventDraft,
  EventDraftError,
  failIntent,
  finalizeEvent,
  type Intent,
  releaseIntent,
  revokeIntent,
  submitIntent,
} from "./intents.js";
import { activeLeaseCount } from "./reducer/handlers/lease.js";
import { applyEntry, replay } from "./reducer/replay.js";
import type { State, TaskState, TaskStatus } from "./reducer/state.js";
import { claimableItems } from "./reducer/views.js";
import type { Snapshot } from "./schemas/snapshot.js";

const metadata = {
  event_id: fakeEventId(301),
  observed_tip: fakeSha("intent-tip"),
  created_at: "2026-10-05T00:00:00Z",
};

describe("event drafts", () => {
  it("keeps typed payloads and supplies the validated English envelope without mutation", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    const before = structuredClone(eventDraft);
    expect(finalizeEvent(eventDraft, metadata)).toEqual({
      ...eventDraft,
      ...metadata,
      schema: "skep.event/v1",
      lang: "en",
    });
    expect(eventDraft).toEqual(before);
    expect(finalizeEvent(eventDraft, metadata)).toEqual(finalizeEvent(eventDraft, metadata));
  });

  it("validates required preconditions with an actionable typed error", () => {
    const eventDraft = draft("task.cancelled", T1, "human", { reason: "Stop work" }, {});
    expect(() => finalizeEvent(eventDraft, metadata)).toThrow(EventDraftError);
    expect(() => finalizeEvent(eventDraft, metadata)).toThrow("missing required pre: task_rev");
    eventDraft.pre = { task_rev: 1 };
    expect(finalizeEvent(eventDraft, metadata).pre).toEqual({ task_rev: 1 });
  });

  it("rejects unknown envelope, payload and precondition keys", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    expect(() =>
      finalizeEvent({ ...eventDraft, extra: true } as typeof eventDraft, metadata),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        { ...eventDraft, payload: { ...eventDraft.payload, extra: true } } as typeof eventDraft,
        metadata,
      ),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        { ...eventDraft, pre: { extra: true } } as unknown as typeof eventDraft,
        metadata,
      ),
    ).toThrow(EventDraftError);
  });

  it("rejects invalid identifiers and timestamps", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    for (const invalid of [
      { ...metadata, event_id: "bad" },
      { ...metadata, observed_tip: "bad" },
      { ...metadata, created_at: "yesterday" },
    ]) {
      expect(() => finalizeEvent(eventDraft, invalid)).toThrow(EventDraftError);
    }
  });

  it("requires null task IDs for registration and a task ID for task events", () => {
    expect(() =>
      finalizeEvent(draft("agent.registered", T1, MAC, agentRegistered(), {}), metadata),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        draft("task.cancelled", null, "human", { reason: "Stop" }, { task_rev: 1 }),
        metadata,
      ),
    ).toThrow(EventDraftError);
  });
});

const REPO = "https://example.invalid/code.git";
const heldAction = { task_id: T1, actor: VPS, item: "W1", epoch: 1 };
const STATUSES: TaskStatus[] = [
  "planning",
  "reviewing",
  "awaiting_approval",
  "executing",
  "interrupting",
  "replanning",
  "delivered",
  "done",
  "escalated",
  "cancelled",
];

function task(state: State, taskId = T1): TaskState {
  const result = state.tasks[taskId];
  if (!result) throw new Error("Fixture task is missing");
  return result;
}

function addTask(builder: LogBuilder, taskId = T1): void {
  builder.append({
    type: "task.created",
    task_id: taskId,
    actor: "human",
    payload: taskCreated({ repo: REPO }),
  });
  const plan = samplePlan({ task_id: taskId });
  plan.base.repo = REPO;
  const proposed = planProposed(plan);
  builder.append({
    type: "plan.proposed",
    task_id: taskId,
    actor: VPS,
    payload: proposed,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.approved",
    task_id: taskId,
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposed.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposed.plan_hash },
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
  const state = replay(builder.entries);
  expect(state.outcomes.every((outcome) => outcome.outcome === "accepted")).toBe(true);
  return { builder, state };
}

function appendDraft(builder: LogBuilder, state: State, eventDraft: EventDraft): State {
  const event = finalizeEvent(eventDraft, {
    ...metadata,
    event_id: fakeEventId(),
    observed_tip: builder.tip,
  });
  return applyEntry(state, builder.appendRaw(event));
}

function publish(builder: LogBuilder, state: State, intent: Intent): State {
  const eventDraft = intent(state);
  if (!eventDraft) throw new Error("Fixture intent was unexpectedly dropped");
  const next = appendDraft(builder, state, eventDraft);
  expect(next.outcomes.at(-1)?.outcome).toBe("accepted");
  return next;
}

function claim(taskId = T1): Intent {
  return claimIntent({ task_id: taskId, actor: VPS, item: "W1", attempt_id: "att_test" });
}

function holding(): { builder: LogBuilder; state: State } {
  const { builder, state } = executing();
  return { builder, state: publish(builder, state, claim()) };
}

function snapshot(): Snapshot {
  return {
    schema: "skep.snapshot/v1",
    item: "W1",
    epoch: 1,
    attempt_id: "att_test",
    branch: workBranch(T1, "W1", 1),
    base_sha: BASE_COMMIT,
    head_sha: null,
    pushed: false,
    invocation_state: "interrupted",
    diffstat: { files: 0, insertions: 0, deletions: 0 },
    files_changed: [],
    check_runs: [],
    agent_note: null,
  };
}

function delivery(): Intent {
  return deliverIntent({
    ...heldAction,
    head_sha: fakeSha("delivery"),
    submit: {
      method: "pr",
      state: "opened",
      pr_url: "https://example.invalid/pull/1",
      pr_number: 1,
    },
    check_runs: [],
  });
}

function checkpoint(barrierId: string | null = null): Intent {
  return checkpointIntent({ ...heldAction, barrier_id: barrierId, snapshot: snapshot() });
}

function openBarrier(builder: LogBuilder, state: State): State {
  builder.append({
    type: "replan.requested",
    actor: "human",
    payload: { summary: "Revise the implementation plan", evidence: [], item: "W1" },
    pre: { task_rev: task(state).rev },
  });
  const next = replay(builder.entries);
  expect(next.outcomes.at(-1)?.outcome).toBe("accepted");
  return next;
}

const FENCED_BUILDERS = [
  {
    name: "release",
    make: () => releaseIntent({ ...heldAction, reason: "Stop this attempt" }),
    statuses: ["executing", "interrupting"],
  },
  { name: "deliver", make: delivery, statuses: ["executing"] },
  {
    name: "fail",
    make: () => failIntent({ ...heldAction, class: "crash", detail: "Agent process exited" }),
    statuses: ["executing", "interrupting"],
  },
  {
    name: "checkpoint",
    make: () => checkpoint(),
    statuses: ["executing", "interrupting", "replanning", "escalated"],
  },
];

describe("lease intent builders", () => {
  const builders = [
    ...FENCED_BUILDERS,
    {
      name: "claim",
      make: claim,
      statuses: ["executing"],
    },
    {
      name: "revoke",
      make: () => revokeIntent({ task_id: T1, item: "W1", epoch: 1, reason: "Holder is stale" }),
      statuses: ["executing", "interrupting", "escalated"],
    },
  ];

  for (const builderCase of builders) {
    describe(builderCase.name, () => {
      it.each(STATUSES)("checks task status %s on every evaluation", (status) => {
        const { state } = builderCase.name === "claim" ? executing() : holding();
        const intent = builderCase.make();
        const t = task(state);
        t.status = status;
        const before = canonicalJson(state);
        if (builderCase.statuses.includes(status)) expect(intent(state)).not.toBeNull();
        else expect(intent(state)).toBeNull();
        expect(canonicalJson(state)).toBe(before);
      });

      it.each(["task", "item"])("drops when the %s disappears", (missing) => {
        const { state } = builderCase.name === "claim" ? executing() : holding();
        const intent = builderCase.make();
        expect(intent(state)).not.toBeNull();
        if (missing === "task") delete state.tasks[T1];
        else delete task(state).items.W1;
        expect(intent(state)).toBeNull();
      });

      it("recomputes revisions and returns independent drafts", () => {
        const { state } = builderCase.name === "claim" ? executing() : holding();
        const intent = builderCase.make();
        const first = intent(state);
        if (!first) throw new Error("Missing draft");
        const before = structuredClone(first);
        task(state).rev += 1;
        expect(intent(state)?.pre.task_rev).toBe(task(state).rev);
        first.pre.task_rev = 999;
        expect(intent(state)?.pre.task_rev).toBe(task(state).rev);
        task(state).rev -= 1;
        expect(intent(state)).toEqual(before);
      });

      it("accepts only one of two drafts computed from the same state", () => {
        const { builder, state } = builderCase.name === "claim" ? executing() : holding();
        const first = builderCase.make()(state);
        const second = builderCase.make()(state);
        if (!first || !second) throw new Error("Missing racing drafts");
        const afterFirst = appendDraft(builder, state, first);
        const afterSecond = appendDraft(builder, afterFirst, second);
        expect(afterFirst.outcomes.at(-1)?.outcome).toBe("accepted");
        expect(afterSecond.outcomes.at(-1)?.outcome).toBe("rejected");
        expect(afterSecond.tasks).toEqual(afterFirst.tasks);
        expect(replay(builder.entries)).toEqual(afterSecond);
      });
    });
  }

  for (const builderCase of FENCED_BUILDERS) {
    it.each(["removed", "holder", "epoch"])(
      `${builderCase.name} rechecks the lease when %s changes`,
      (change) => {
        const { state } = holding();
        const intent = builderCase.make();
        const item = task(state).items.W1;
        if (!item?.lease) throw new Error("Missing lease");
        expect(intent(state)).not.toBeNull();
        if (change === "removed") item.lease = null;
        else if (change === "holder") item.lease.holder = MAC;
        else item.lease.epoch += 1;
        expect(intent(state)).toBeNull();
      },
    );
  }

  it.each(["release", "revoke", "deliver", "fail", "cancel", "barrier_closed", "activate"])(
    "drops every old fenced action after replaying %s",
    (change) => {
      const { builder, state } = holding();
      const intents = FENCED_BUILDERS.map((entry) => entry.make());
      let next = state;
      if (change === "release")
        next = publish(
          builder,
          next,
          releaseIntent({ ...heldAction, reason: "Stop this attempt" }),
        );
      if (change === "revoke")
        next = publish(
          builder,
          next,
          revokeIntent({ task_id: T1, item: "W1", epoch: 1, reason: "Holder is stale" }),
        );
      if (change === "deliver") next = publish(builder, next, delivery());
      if (change === "fail")
        next = publish(
          builder,
          next,
          failIntent({ ...heldAction, class: "crash", detail: "Agent process exited" }),
        );
      if (change === "cancel") {
        builder.append({
          type: "task.cancelled",
          actor: "human",
          payload: { reason: "Cancel this task" },
          pre: { task_rev: task(next).rev },
        });
        next = replay(builder.entries);
      }
      if (change === "barrier_closed" || change === "activate") {
        next = openBarrier(builder, next);
        const barrierId = task(next).barrier?.id;
        if (!barrierId) throw new Error("Missing barrier");
        if (change === "barrier_closed") {
          builder.append({
            type: "barrier.closed",
            actor: "human",
            payload: { barrier_id: barrierId, missing: ["W1"] },
            pre: { task_rev: task(next).rev },
          });
        } else {
          next = publish(builder, next, checkpoint(barrierId));
          const plan = samplePlan({
            version: 2,
            parent_version: 1,
            changes_from_parent: "Revise the item implementation",
          });
          plan.base.repo = REPO;
          const proposal = planProposed(plan);
          builder.append({
            type: "plan.proposed",
            actor: VPS,
            payload: proposal,
            pre: { task_rev: task(next).rev, owner_gen: task(next).owner_gen },
          });
          next = replay(builder.entries);
          builder.append({
            type: "plan.approved",
            actor: "human",
            payload: { plan_version: 2, plan_hash: proposal.plan_hash },
            pre: { task_rev: task(next).rev, plan_version: 2, plan_hash: proposal.plan_hash },
          });
        }
        next = replay(builder.entries);
      }
      expect(next.outcomes.every((entry) => entry.outcome === "accepted")).toBe(true);
      for (const intent of intents) expect(intent(next)).toBeNull();
    },
  );

  it("preserves attempt fencing when a revoked item is claimed under a new epoch", () => {
    const { builder, state } = holding();
    const intents = FENCED_BUILDERS.map((entry) => entry.make());
    const revoke = revokeIntent({ task_id: T1, item: "W1", epoch: 1, reason: "Reclaim the item" });
    const released = publish(builder, state, revoke);
    const reclaimed = publish(builder, released, claim());
    expect(task(reclaimed).items.W1?.lease?.epoch).toBe(2);
    for (const intent of [...intents, revoke]) expect(intent(reclaimed)).toBeNull();
  });

  it("allows barrier settlement while blocking claims and delivery", () => {
    const { builder, state } = holding();
    const interrupting = openBarrier(builder, state);
    const barrierId = task(interrupting).barrier?.id;
    if (!barrierId) throw new Error("Missing barrier");
    expect(claim()(interrupting)).toBeNull();
    expect(delivery()(interrupting)).toBeNull();
    expect(
      releaseIntent({ ...heldAction, reason: "Stop for the barrier" })(interrupting),
    ).not.toBeNull();
    expect(
      failIntent({ ...heldAction, class: "crash", detail: "Stopped" })(interrupting),
    ).not.toBeNull();
    const parked = publish(builder, interrupting, checkpoint(barrierId));
    expect(task(parked).items.W1?.status).toBe("interrupted");
    expect(checkpoint(barrierId)(parked)).not.toBeNull();
    expect(delivery()(parked)).toBeNull();
    expect(
      revokeIntent({ task_id: T1, item: "W1", epoch: 1, reason: "Revoke" })(parked),
    ).toBeNull();
    task(parked).status = "escalated";
    expect(
      revokeIntent({ task_id: T1, item: "W1", epoch: 1, reason: "Revoke" })(parked),
    ).not.toBeNull();
  });

  it("rejects an interrupted delivery even if the task still says executing", () => {
    const { state } = holding();
    const lease = task(state).items.W1?.lease;
    if (!lease) throw new Error("Missing lease");
    lease.interrupt = "B10";
    expect(delivery()(state)).toBeNull();
  });

  it.each(["item", "epoch", "barrier"])("checks checkpoint %s fencing", (change) => {
    const { state } = holding();
    const options = { ...heldAction, barrier_id: null as string | null, snapshot: snapshot() };
    if (change === "item") options.snapshot.item = "W2";
    if (change === "epoch") options.snapshot.epoch = 2;
    if (change === "barrier") options.barrier_id = "B10";
    expect(checkpointIntent(options)(state)).toBeNull();
  });

  it("drops a barrier checkpoint when its barrier changes or disappears", () => {
    const { builder, state } = holding();
    const interrupted = openBarrier(builder, state);
    const barrier = task(interrupted).barrier;
    if (!barrier) throw new Error("Missing barrier");
    const intent = checkpoint(barrier.id);
    expect(intent(interrupted)).not.toBeNull();
    barrier.id = "B99";
    expect(intent(interrupted)).toBeNull();
    task(interrupted).barrier = null;
    expect(intent(interrupted)).toBeNull();
  });

  it("isolates fixed result data from caller and draft mutation", () => {
    const { state } = holding();
    const options = { ...heldAction, barrier_id: null, snapshot: snapshot() };
    const intent = checkpointIntent(options);
    const first = intent(state);
    if (!first) throw new Error("Missing checkpoint draft");
    const expected = structuredClone(first);
    options.snapshot.epoch = 9;
    const payload = first.payload as { snapshot: Snapshot };
    payload.snapshot.files_changed.push("src/example.ts");
    expect(intent(state)).toEqual(expected);
  });
});

describe("claim capacity and fresh state", () => {
  it.each([
    "blocked",
    "assignee",
    "agent",
    "budget",
    "barrier",
    "active_plan",
    "plan",
    "current_plan",
  ])("drops a claim when %s changes", (change) => {
    const { state } = executing();
    const intent = claim();
    expect(intent(state)).not.toBeNull();
    const t = task(state);
    const item = t.items.W1;
    if (!item) throw new Error("Missing item");
    if (change === "blocked") item.status = "blocked";
    if (change === "assignee") item.assignee = MAC;
    if (change === "agent") delete state.agents[VPS];
    if (change === "budget") item.attempts_this_plan = t.budgets.item_retries + 1;
    if (change === "barrier")
      t.barrier = {
        id: "B10",
        opened_seq: 10,
        closed_seq: null,
        requests: [],
        awaiting: [],
        checkpointed: [],
        escalate: false,
      };
    if (change === "active_plan") t.active_plan_version = null;
    if (change === "plan") delete t.plans["1"];
    if (change === "current_plan") t.current_plan_version = 2;
    expect(intent(state)).toBeNull();
  });

  it("derives epoch, plan hash, revision, and branch anew on each invocation", () => {
    const { state } = executing();
    const intent = claim();
    const first = intent(state);
    const t = task(state);
    const plan = t.plans["1"];
    if (!plan) throw new Error("Missing plan");
    t.epochs.W1 = 4;
    t.rev = 20;
    t.active_plan_version = 2;
    t.current_plan_version = 2;
    t.plans["2"] = { ...plan, version: 2, plan_hash: `sha256:${"a".repeat(64)}` };
    expect(intent(state)).toMatchObject({
      payload: { branch: workBranch(T1, "W1", 5), attempt_id: "att_test" },
      pre: { task_rev: 20, expected_epoch: 4, plan_version: 2, plan_hash: t.plans["2"].plan_hash },
    });
    expect(first?.pre.expected_epoch).toBe(0);
  });

  it("limits candidates to remaining slots across tasks and drops queued excess claims", () => {
    const { builder, state } = executing(2);
    addTask(builder, T2);
    addTask(builder, "T-20261005-abcd");
    const ready = replay(builder.entries);
    expect(claimableItems(ready, VPS)).toHaveLength(3);
    expect(claimCandidates(ready, VPS)).toEqual(claimableItems(ready, VPS).slice(0, 2));
    const queued = claim(T2);
    const oneHeld = publish(builder, ready, claim());
    expect(activeLeaseCount(oneHeld, VPS)).toBe(1);
    expect(claimCandidates(oneHeld, VPS)).toHaveLength(1);
    const twoHeld = publish(builder, oneHeld, claim("T-20261005-abcd"));
    expect(claimCandidates(twoHeld, VPS)).toEqual([]);
    expect(queued(twoHeld)).toBeNull();
    expect(state.tasks[T2]).toBeUndefined();
  });

  it("counts flagged leases until checkpointed, then excludes parked leases (D16/F15)", () => {
    const { builder, state } = holding();
    addTask(builder, T2);
    const next = replay(builder.entries);
    const intent = claim(T2);
    expect(intent(next)).toBeNull();
    const interrupted = openBarrier(builder, next);
    expect(claimCandidates(interrupted, VPS)).toEqual([]);
    expect(intent(interrupted)).toBeNull();
    const barrierId = task(interrupted).barrier?.id;
    if (!barrierId) throw new Error("Missing barrier");
    const parked = publish(builder, interrupted, checkpoint(barrierId));
    expect(activeLeaseCount(parked, VPS)).toBe(0);
    expect(claimCandidates(parked, VPS).map((entry) => entry.task_id)).toEqual([T2]);
    expect(intent(parked)).not.toBeNull();
    expect(state.tasks[T2]).toBeUndefined();
  });

  it("returns no candidates for unregistered agents and honors changed capacity", () => {
    const { builder } = executing(2);
    addTask(builder, T2);
    let state = replay(builder.entries);
    state = publish(builder, state, claim());
    expect(claimCandidates(state, VPS)).toHaveLength(1);
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    state = replay(builder.entries);
    expect(claimCandidates(state, VPS)).toEqual([]);
    expect(claim(T2)(state)).toBeNull();
    expect(claimCandidates(state, "vps.coding.2")).toEqual([]);
  });
});

describe("submitIntent", () => {
  function pending() {
    const { builder, state } = holding();
    return {
      builder,
      state: publish(
        builder,
        state,
        deliverIntent({
          ...heldAction,
          head_sha: fakeSha("pending"),
          submit: { method: "ask", state: "pending" },
          check_runs: [],
        }),
      ),
    };
  }
  const action = {
    task_id: T1,
    actor: "human",
    item: "W1",
    method: "none",
    state: "local",
  } as const;

  it.each(["executing", "delivered", "escalated"] as const)(
    "accepts a lease-free submission while %s",
    (status) => {
      const { builder, state } = pending();
      task(state).status = status;
      const intent = submitIntent(action);
      const next = publish(builder, state, intent);
      expect(next.outcomes.at(-1)?.outcome).toBe("accepted");
      expect(task(next).items.W1?.submission).toMatchObject({
        epoch: 1,
        head_sha: fakeSha("pending"),
        method: "none",
        state: "local",
      });
      expect(task(next).items.W1?.status).toBe("delivered");
      expect(intent(next)).toBeNull();
    },
  );

  it.each(["task", "item", "status", "pending", "epoch", "head", "submission"])(
    "rechecks %s before publishing",
    (change) => {
      const { state } = pending();
      const intent = submitIntent({ ...action, epoch: 1, head_sha: fakeSha("pending") });
      expect(intent(state)).not.toBeNull();
      const item = task(state).items.W1;
      if (!item?.delivered) throw new Error("Missing delivery");
      if (change === "task") delete state.tasks[T1];
      if (change === "item") delete task(state).items.W1;
      if (change === "status") task(state).status = "interrupting";
      if (change === "pending") item.delivered.submit = { method: "none", state: "local" };
      if (change === "epoch") item.delivered.epoch++;
      if (change === "head") item.delivered.head_sha = fakeSha("changed");
      if (change === "submission")
        item.submission = {
          item: "W1",
          epoch: 1,
          method: "none",
          state: "skipped",
          head_sha: fakeSha("pending"),
          seq: state.seq,
        };
      expect(intent(state)).toBeNull();
    },
  );

  it("derives epoch, SHA and revision from fresh delivery state", () => {
    const { state } = pending();
    const intent = submitIntent(action);
    const item = task(state).items.W1;
    if (!item?.delivered) throw new Error("Missing delivery");
    item.delivered.epoch = 2;
    item.delivered.head_sha = fakeSha("new");
    task(state).rev++;
    expect(intent(state)).toMatchObject({
      payload: { epoch: 2, head_sha: fakeSha("new") },
      pre: { task_rev: task(state).rev, item: "W1" },
    });
  });

  it("isolates PR data and drops incomplete or inconsistent submissions", () => {
    const { state } = pending();
    const options = {
      ...action,
      method: "pr",
      state: "opened",
      pr_url: "https://example.invalid/pull/1",
      pr_number: 1,
    } as const;
    const intent = submitIntent(options);
    const first = intent(state);
    if (!first) throw new Error("Missing draft");
    const expected = structuredClone(first);
    (first.payload as { pr_number: number }).pr_number = 99;
    expect(intent(state)).toEqual(expected);
    expect(submitIntent({ ...options, pr_number: undefined })(state)).toBeNull();
    expect(submitIntent({ ...options, state: "pushed" })(state)).toBeNull();
  });
});
