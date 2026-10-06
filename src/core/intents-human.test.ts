import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { contentHash } from "./canonical.js";
import { finalizeEvent } from "./intents.js";
import {
  humanDecideIntent,
  leaseRevokeIntent,
  planApproveIntent,
  planRejectIntent,
  replanRequestIntent,
  taskCancelIntent,
  taskCreateIntent,
  titleFromBody,
} from "./intents-human.js";
import { applyEntry, replay } from "./reducer/replay.js";
import type { State, TaskStatus } from "./reducer/state.js";
import { DEFAULT_BUDGETS } from "./schemas/common.js";

const metadata = {
  event_id: "evt_00000000-0000-4000-8000-000000000603",
  observed_tip: "a".repeat(40),
  created_at: "2026-10-05T00:00:00Z",
};

/** A state with two registered agents and one solo task owned by vps.coding. */
function state(): State {
  const log = new LogBuilder();
  log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  log.append({ type: "task.created", actor: "human", payload: taskCreated() });
  return replay(log.entries);
}

function withStatus(base: State, status: TaskStatus): State {
  const task = base.tasks[T1];
  if (!task) throw new Error("fixture has no task");
  return { ...base, tasks: { ...base.tasks, [T1]: { ...task, status } } };
}

describe("titleFromBody", () => {
  it("uses the first line and clips to the short-text limit", () => {
    expect(titleFromBody("Add a toggle\n\nDetails follow.")).toBe("Add a toggle");
    expect(titleFromBody(`  ${"x".repeat(600)}  `)).toHaveLength(500);
    expect(titleFromBody("   \n")).toBe("Task");
  });
});

describe("taskCreateIntent", () => {
  const input = {
    title: "Add a toggle",
    body: "Add a dark mode toggle to Settings.",
    repo: "app",
    mode: "solo" as const,
  };

  it("re-derives budgets, the human approval gate and the named owner", () => {
    const draft = taskCreateIntent({ ...input, owner: VPS }, T1)(state());
    expect(draft).toMatchObject({
      type: "task.created",
      task_id: T1,
      actor: "human",
      payload: {
        owner: VPS,
        mode: "solo",
        plan_approval: "human",
        budgets: DEFAULT_BUDGETS,
        base_branch: "main",
      },
    });
    expect(finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: state().tip }).type).toBe(
      "task.created",
    );
  });

  it("picks the only registered agent when no owner is named", () => {
    const log = new LogBuilder();
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    const draft = taskCreateIntent(input, T1)(replay(log.entries));
    expect(draft?.payload).toMatchObject({ owner: MAC });
  });

  it("returns null for an unknown owner, and for an ambiguous registry", () => {
    expect(taskCreateIntent({ ...input, owner: "mac.review" }, T1)(state())).toBeNull();
    expect(taskCreateIntent(input, T1)(state())).toBeNull();
  });

  it("keeps the original text for audit and never hands it to the body", () => {
    const draft = taskCreateIntent(
      { ...input, owner: VPS, originalText: "原始文本", originalLang: "zh" },
      T1,
    )(state());
    expect(draft?.payload).toMatchObject({
      body: input.body,
      original_text: "原始文本",
      original_lang: "zh",
    });
  });

  it("is accepted by the reducer for a registered owner", () => {
    const base = state();
    const draft = taskCreateIntent({ ...input, owner: VPS, mode: "team" }, "T-20261006-abcd")(base);
    const event = finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: base.tip });
    const next = applyEntry(base, entryFor(base, event));
    expect(next.tasks["T-20261006-abcd"]).toMatchObject({
      status: "planning",
      owner: VPS,
      mode: "team",
    });
  });
});

describe("taskCancelIntent", () => {
  it("carries the current task_rev and returns null once the task is terminal", () => {
    const base = state();
    expect(taskCancelIntent(T1, "no longer needed")(base)).toMatchObject({
      type: "task.cancelled",
      pre: { task_rev: base.tasks[T1]?.rev },
      payload: { reason: "no longer needed" },
    });
    expect(taskCancelIntent(T1, "again")(withStatus(base, "cancelled"))).toBeNull();
    expect(taskCancelIntent(T1, "again")(withStatus(base, "done"))).toBeNull();
    expect(taskCancelIntent("T-20261005-0000", "missing")(base)).toBeNull();
  });
});

describe("plan decisions", () => {
  /** A task whose current plan is locked and awaiting the human. */
  function awaiting(): State {
    const log = new LogBuilder();
    log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    log.append({ type: "task.created", actor: "human", payload: taskCreated() });
    log.append({
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(),
      pre: { task_rev: 1, owner_gen: 1 },
    });
    return replay(log.entries);
  }

  it("approves the locked plan, pinning the hash it re-derives from state", () => {
    const base = awaiting();
    const plan = base.tasks[T1]?.plans["1"];
    const draft = planApproveIntent(T1, { note: "ship it" })(base);
    expect(draft).toMatchObject({
      type: "plan.approved",
      actor: "human",
      payload: { plan_version: 1, plan_hash: plan?.plan_hash, note: "ship it" },
      pre: { task_rev: base.tasks[T1]?.rev, plan_version: 1, plan_hash: plan?.plan_hash },
    });
  });

  it("returns null when the named hash is not the plan awaiting approval", () => {
    const base = awaiting();
    const other = `sha256:${"ab".repeat(32)}`;
    expect(planApproveIntent(T1, { planHash: other })(base)).toBeNull();
    expect(planRejectIntent(T1, { planHash: other })(base)).toBeNull();
  });

  it("returns null unless the task is awaiting approval of a locked plan", () => {
    const base = state();
    expect(planApproveIntent(T1)(base)).toBeNull();
    expect(planRejectIntent(T1)(withStatus(base, "reviewing"))).toBeNull();
  });

  it("rejects with the note and moves the task back to planning", () => {
    const base = awaiting();
    const draft = planRejectIntent(T1, { note: "needs tests" })(base);
    const event = finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: base.tip });
    const next = applyEntry(base, entryFor(base, event));
    expect(next.tasks[T1]).toMatchObject({ status: "planning", review_rounds: 1 });
    expect(next.outcomes.at(-1)?.outcome).toBe("accepted");
  });
});

describe("leaseRevokeIntent", () => {
  function leased(): State {
    const log = new LogBuilder();
    log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    log.append({ type: "task.created", actor: "human", payload: taskCreated() });
    log.append({
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(),
      pre: { task_rev: 1, owner_gen: 1 },
    });
    const approved = replay(log.entries);
    const hash = approved.tasks[T1]?.plans["1"]?.plan_hash ?? "";
    log.append({
      type: "plan.approved",
      actor: "human",
      payload: { plan_version: 1, plan_hash: hash },
      pre: { task_rev: 2, plan_version: 1, plan_hash: hash },
    });
    log.append({
      type: "lease.claimed",
      actor: VPS,
      payload: { item: "W1", attempt_id: "att_01", branch: `skep/${T1}/W1/e1` },
      pre: { task_rev: 3, plan_version: 1, plan_hash: hash, item: "W1", expected_epoch: 0 },
    });
    return replay(log.entries);
  }

  it("revokes the exact epoch and carries no heartbeat evidence", () => {
    const base = leased();
    const draft = leaseRevokeIntent(T1, "W1", 1, "holder went stale")(base);
    expect(draft).toMatchObject({
      type: "lease.revoked",
      actor: "human",
      payload: { item: "W1", epoch: 1, reason: "holder went stale", observed_hb: null },
    });
    const event = finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: base.tip });
    const next = applyEntry(base, entryFor(base, event));
    expect(next.tasks[T1]?.items.W1?.lease).toBeNull();
    expect(next.tasks[T1]?.items.W1?.status).toBe("ready");
  });

  it("returns null for a stale epoch, an unknown item, or a task that cannot be fenced", () => {
    const base = leased();
    expect(leaseRevokeIntent(T1, "W1", 2)(base)).toBeNull();
    expect(leaseRevokeIntent(T1, "W2", 1)(base)).toBeNull();
    expect(leaseRevokeIntent(T1, "W1", 1)(withStatus(base, "delivered"))).toBeNull();
  });

  it("still revokes a lease on an escalated task", () => {
    const base = withStatus(leased(), "escalated");
    expect(leaseRevokeIntent(T1, "W1", 1)(base)?.type).toBe("lease.revoked");
  });
});

describe("humanDecideIntent", () => {
  it("returns null unless the task is escalated", () => {
    expect(humanDecideIntent(T1, "cancel")(state())).toBeNull();
    expect(humanDecideIntent(T1, "reassign_owner")(withStatus(state(), "escalated"))).toBeNull();
  });

  it("reassigns only to the owner the human named", () => {
    const base = withStatus(state(), "escalated");
    const draft = humanDecideIntent(T1, "reassign_owner", { newOwner: MAC, note: "handover" })(
      base,
    );
    expect(draft).toMatchObject({
      type: "human.decided",
      payload: { decision: "reassign_owner", new_owner: MAC, note: "handover" },
      pre: { task_rev: base.tasks[T1]?.rev },
    });
    const event = finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: base.tip });
    const next = applyEntry(base, entryFor(base, event));
    expect(next.tasks[T1]).toMatchObject({ status: "planning", owner: MAC, owner_gen: 2 });
  });
});

describe("replanRequestIntent", () => {
  function executing(): State {
    const log = new LogBuilder();
    log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    log.append({ type: "task.created", actor: "human", payload: taskCreated() });
    log.append({
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(),
      pre: { task_rev: 1, owner_gen: 1 },
    });
    const awaiting = replay(log.entries);
    const hash = awaiting.tasks[T1]?.plans["1"]?.plan_hash ?? "";
    log.append({
      type: "plan.approved",
      actor: "human",
      payload: { plan_version: 1, plan_hash: hash },
      pre: { task_rev: 2, plan_version: 1, plan_hash: hash },
    });
    return replay(log.entries);
  }

  it("opens a barrier without evidence, which a human request does not need", () => {
    const base = executing();
    const draft = replanRequestIntent(T1, "the approach fails")(base);
    expect(draft).toMatchObject({
      type: "replan.requested",
      actor: "human",
      payload: { summary: "the approach fails", evidence: [], item: null },
    });
    const event = finalizeEvent(draft ?? fail(), { ...metadata, observed_tip: base.tip });
    const next = applyEntry(base, entryFor(base, event));
    expect(next.tasks[T1]?.status).toBe("replanning");
    expect(next.tasks[T1]?.replan_count).toBe(1);
  });

  it("returns null for an item the task does not have, and outside the replannable statuses", () => {
    const base = executing();
    expect(replanRequestIntent(T1, "why", { item: "W2" })(base)).toBeNull();
    expect(replanRequestIntent(T1, "why")(withStatus(base, "escalated"))).toBeNull();
    expect(replanRequestIntent(T1, "why")(state())).toBeNull();
  });
});

describe("determinism", () => {
  it("builds the same draft twice from the same state", () => {
    const base = state();
    const once = taskCancelIntent(T1, "stop")(base);
    const twice = taskCancelIntent(T1, "stop")(base);
    expect(once).toEqual(twice);
    expect(contentHash(once)).toBe(contentHash(twice));
  });
});

function fail(): never {
  throw new Error("expected a draft");
}

/** A log entry shaped like the git reader's, so applyEntry replays the draft for real. */
function entryFor(
  base: State,
  event: { task_id: string | null; event_id: string },
): Parameters<typeof applyEntry>[1] {
  return {
    seq: base.seq + 1,
    sha: metadata.observed_tip,
    parents: [base.tip],
    signature: { status: "good", principal: "human" },
    changes: [{ status: "A", path: `events/${event.task_id ?? "_skep"}/${event.event_id}.json` }],
    added: {
      [`events/${event.task_id ?? "_skep"}/${event.event_id}.json`]: `${JSON.stringify(event)}\n`,
    },
  };
}
