import { describe, expect, it } from "vitest";
import type { EventSpec } from "../../../../test/helpers/log-builder.js";
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
import { contentHash } from "../../canonical.js";
import { workBranch } from "../../ids.js";
import type { EventType, PayloadOf, Pre } from "../../schemas/events.js";
import type { Plan, PlanItem } from "../../schemas/plan.js";
import { replay } from "../replay.js";
import type { TaskState } from "../state.js";
import { activatePlan } from "./plan.js";

function task(builder: LogBuilder): TaskState {
  const result = replay(builder.entries).tasks[T1];
  if (!result) throw new Error("fixture task missing");
  return result;
}

function planning(
  mode: "solo" | "team" = "solo",
  policy: "human" | "owner" = "human",
  budget = 2,
): LogBuilder {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const payload = taskCreated({ mode, plan_approval: policy });
  payload.budgets.review_rounds = budget;
  builder.append({ type: "task.created", actor: "human", payload });
  return builder;
}

function append<T extends EventType>(builder: LogBuilder, spec: EventSpec<T>): void {
  const current = task(builder);
  const pre: Pre = { task_rev: current.rev, owner_gen: current.owner_gen };
  if (current.current_plan_version !== null) {
    pre.plan_version = current.current_plan_version;
    pre.plan_hash = current.plans[String(current.current_plan_version)]?.plan_hash;
  }
  builder.append({ ...spec, pre: { ...pre, ...spec.pre } });
}

function teamPlan(overrides: Partial<Plan> = {}): Plan {
  const first = samplePlan().items[0];
  if (!first) throw new Error("fixture item missing");
  return samplePlan({
    mode: "team",
    items: [
      first,
      { ...first, id: "W2", title: "Settings toggle", assignee: MAC, depends_on: ["W1"] },
    ],
    stack_order: ["W1", "W2"],
    ...overrides,
  });
}

function propose(builder: LogBuilder, plan: Plan = samplePlan()): void {
  append(builder, {
    type: "plan.proposed",
    actor: VPS,
    payload: planProposed(plan, plan.mode === "team" ? [MAC] : []),
  });
}

function decision(builder: LogBuilder, type: "plan.approved" | "plan.rejected"): void {
  const current = task(builder);
  const record = current.plans[String(current.current_plan_version)];
  if (!record) throw new Error("fixture plan missing");
  append(builder, {
    type,
    actor: "human",
    payload: { plan_version: record.version, plan_hash: record.plan_hash, note: "Human decision" },
  });
}

function review(
  builder: LogBuilder,
  verdict: "approve" | "block" | "comment" = "approve",
  actor = MAC,
): void {
  const current = task(builder);
  const record = current.plans[String(current.current_plan_version)];
  if (!record) throw new Error("fixture plan missing");
  append(builder, {
    type: "review.submitted",
    actor,
    payload: {
      plan_version: record.version,
      plan_hash: record.plan_hash,
      verdict,
      blockers:
        verdict === "block"
          ? [
              {
                id: "B1",
                claim: "A check is missing",
                evidence: [
                  {
                    id: "ev_check",
                    type: "check_run",
                    run_id: "run1",
                    check: "unit",
                    sha: fakeSha("evidence"),
                    exit: 1,
                    log_sha256: "a".repeat(64),
                  },
                ],
              },
            ]
          : [],
      suggestions: [],
    },
  });
}

function lock(
  builder: LogBuilder,
  overrides: PayloadOf<"plan.locked">["overrides"] = [],
  missing: string[] = [],
): void {
  const current = task(builder);
  const record = current.plans[String(current.current_plan_version)];
  if (!record) throw new Error("fixture plan missing");
  append(builder, {
    type: "plan.locked",
    actor: VPS,
    payload: {
      plan_version: record.version,
      plan_hash: record.plan_hash,
      overrides,
      missing_reviews: missing,
    },
  });
}

describe("plan lifecycle", () => {
  it("implicitly locks a solo proposal, then executes after human approval", () => {
    const builder = planning();
    propose(builder);
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "awaiting_approval",
      current_plan_version: 1,
      active_plan_version: null,
      items: {},
      plans: { "1": { locked: { seq: 4, overrides: [], missing_reviews: [] }, decision: null } },
    });
    decision(builder, "plan.approved");
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "executing",
      rev: 3,
      active_plan_version: 1,
      items: {
        W1: { status: "ready", requires: [], lease: null, delivered: null, attempts_this_plan: 0 },
      },
      plans: { "1": { decision: { kind: "approved", note: "Human decision", seq: 5 } } },
    });
  });

  it("reviews and locks a two-item team plan before human approval", () => {
    const builder = planning("team");
    const plan = teamPlan();
    plan.items.reverse();
    propose(builder, plan);
    expect(task(builder).status).toBe("reviewing");
    review(builder);
    lock(builder);
    expect(task(builder).status).toBe("awaiting_approval");
    decision(builder, "plan.approved");
    const t = task(builder);
    expect(t).toMatchObject({
      mode: "team",
      status: "executing",
      rev: 5,
      active_plan_version: 1,
      items: {
        W1: { status: "ready", assignee: VPS },
        W2: { status: "blocked", assignee: MAC, depends_on: ["W1"] },
      },
      plans: {
        "1": {
          reviewers: [MAC],
          locked: { seq: 6 },
          reviews: { [MAC]: { verdict: "approve", seq: 5 } },
        },
      },
    });
    expect(Object.keys(t.items)).toEqual(["W1", "W2"]);
    expect(
      replay(builder.entries).outcomes.every((outcome) => outcome.outcome === "accepted"),
    ).toBe(true);
  });

  it.each(["solo", "team"] as const)(
    "starts a normal-risk %s plan on owner-policy lock",
    (mode) => {
      const builder = planning(mode, "owner");
      propose(builder, mode === "team" ? teamPlan() : samplePlan());
      lock(builder, [], mode === "team" ? [MAC] : []);
      expect(task(builder)).toMatchObject({
        status: "executing",
        active_plan_version: 1,
        items: { W1: { status: "ready" } },
      });
    },
  );

  it.each(["solo", "team"] as const)(
    "requires human approval for high-risk %s plans under owner policy",
    (mode) => {
      const builder = planning(mode, "owner");
      const plan = mode === "team" ? teamPlan() : samplePlan();
      if (plan.items[0]) plan.items[0].risk = "high";
      propose(builder, plan);
      lock(builder, [], mode === "team" ? [MAC] : []);
      expect(task(builder).status).toBe("awaiting_approval");
      expect(task(builder).active_plan_version).toBeNull();
      decision(builder, "plan.approved");
      expect(task(builder).status).toBe("executing");
    },
  );

  it("counts rejected versions and escalates the third rejection with budget 2", () => {
    const builder = planning();
    for (let version = 1; version <= 3; version++) {
      propose(builder, samplePlan({ version, parent_version: version === 1 ? null : version - 1 }));
      decision(builder, "plan.rejected");
      expect(task(builder)).toMatchObject({
        review_rounds: version,
        status: version > 2 ? "escalated" : "planning",
      });
    }
    expect(task(builder).escalation).toEqual({ reason: "review_rounds", seq: 9 });
    expect(task(builder).plans["1"]?.decision?.kind).toBe("rejected");
    expect(task(builder).rev).toBe(7);
  });

  it("counts superseded blocked versions once and escalates when over budget", () => {
    const builder = planning("team", "human", 1);
    propose(builder, teamPlan());
    review(builder, "block");
    propose(builder, teamPlan({ version: 2, parent_version: 1 }));
    expect(task(builder)).toMatchObject({ review_rounds: 1, status: "reviewing" });
    review(builder, "block");
    propose(builder, teamPlan({ version: 3, parent_version: 2 }));
    expect(task(builder)).toMatchObject({
      review_rounds: 2,
      status: "escalated",
      escalation: { reason: "review_rounds" },
    });
  });

  it("does not count a blocked and then rejected version twice", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder, "block");
    lock(builder, [
      { reviewer: MAC, blocker_id: "B1", rationale: "The human will verify manually" },
    ]);
    decision(builder, "plan.rejected");
    propose(builder, teamPlan({ version: 2, parent_version: 1 }));
    expect(task(builder).review_rounds).toBe(1);
  });

  it("overwrites a review with the reviewer's latest verdict", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder, "block");
    review(builder, "approve");
    expect(task(builder).plans["1"]?.reviews[MAC]).toMatchObject({ verdict: "approve", seq: 6 });
    propose(builder, teamPlan({ version: 2, parent_version: 1 }));
    expect(task(builder).review_rounds).toBe(0);
  });

  it("allows human reviews outside the frozen peer set", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder, "comment", "human");
    expect(task(builder).plans["1"]?.reviews.human?.verdict).toBe("comment");
    lock(builder, [], [MAC]);
    expect(task(builder).status).toBe("awaiting_approval");
  });

  it("accepts a valid blocker override without requiring unanimity", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder, "block");
    const overrides = [
      { reviewer: MAC, blocker_id: "B1", rationale: "Accepted risk for this release" },
    ];
    lock(builder, overrides);
    expect(task(builder)).toMatchObject({
      status: "awaiting_approval",
      review_rounds: 0,
      plans: { "1": { locked: { overrides } } },
    });
  });

  it.each([
    ["unknown reviewer", "mac.coding.2", "B1", "block"],
    ["unknown blocker", MAC, "B2", "block"],
    ["non-block review", MAC, "B1", "approve"],
  ] as const)("rejects an override for %s", (_name, reviewer, blocker_id, verdict) => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder, verdict);
    const before = task(builder);
    lock(builder, [{ reviewer, blocker_id, rationale: "Override" }]);
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("invalid_plan");
    expect(task(builder)).toEqual(before);
  });

  it.each([[], [MAC, MAC], ["mac.coding.2"]].map((missing) => ({ missing })))(
    "requires the exact missing reviewer set: %j",
    ({ missing }) => {
      const builder = planning("team");
      propose(builder, teamPlan());
      lock(builder, [], missing);
      expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("invalid_plan");
    },
  );

  it("rejects reporting an already received review as missing", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder);
    lock(builder, [], [MAC]);
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("invalid_plan");
  });
});

describe("plan-mode routing (D13)", () => {
  it("reviews and locks a team plan for a solo task, then switches mode on human approval", () => {
    const builder = planning();
    propose(builder, teamPlan());
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "reviewing",
      current_plan_version: 1,
      active_plan_version: null,
      items: {},
      plans: { "1": { reviewers: [MAC], locked: null } },
    });

    const before = task(builder);
    decision(builder, "plan.approved");
    expect(replay(builder.entries).outcomes.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "bad_task_state",
    });
    expect(task(builder)).toEqual(before);

    review(builder);
    expect(task(builder).plans["1"]?.reviews[MAC]?.verdict).toBe("approve");
    lock(builder);
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "awaiting_approval",
      active_plan_version: null,
      plans: { "1": { locked: { overrides: [], missing_reviews: [] } } },
    });
    decision(builder, "plan.approved");
    expect(task(builder)).toMatchObject({
      mode: "team",
      status: "executing",
      active_plan_version: 1,
      items: {
        W1: { status: "ready", assignee: VPS },
        W2: { status: "blocked", assignee: MAC },
      },
    });
    expect(
      replay(builder.entries)
        .outcomes.slice(-3)
        .map((outcome) => outcome.outcome),
    ).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("keeps a rejected team proposal solo and allows a subsequent solo plan", () => {
    const builder = planning();
    propose(builder, teamPlan());
    lock(builder, [], [MAC]);
    decision(builder, "plan.rejected");
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "planning",
      active_plan_version: null,
      review_rounds: 1,
      items: {},
      plans: { "1": { decision: { kind: "rejected" } } },
    });
    propose(builder, samplePlan({ version: 2, parent_version: 1 }));
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "awaiting_approval",
      plans: { "2": { reviewers: [], locked: { overrides: [], missing_reviews: [] } } },
    });
    decision(builder, "plan.approved");
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "executing",
      active_plan_version: 2,
    });
    expect(
      replay(builder.entries).outcomes.every((outcome) => outcome.outcome === "accepted"),
    ).toBe(true);
  });

  it.each(["normal", "high"] as const)(
    "activates a %s-risk team upgrade according to owner approval policy",
    (risk) => {
      const builder = planning("solo", "owner");
      const plan = teamPlan();
      for (const item of plan.items) item.risk = risk;
      propose(builder, plan);
      expect(task(builder)).toMatchObject({ mode: "solo", status: "reviewing" });
      lock(builder, [], [MAC]);
      if (risk === "high") {
        expect(task(builder)).toMatchObject({
          mode: "solo",
          status: "awaiting_approval",
          active_plan_version: null,
        });
        const before = task(builder);
        lock(builder, [], [MAC]);
        expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("bad_task_state");
        expect(task(builder)).toEqual(before);
        decision(builder, "plan.approved");
      }
      expect(task(builder)).toMatchObject({
        mode: "team",
        status: "executing",
        active_plan_version: 1,
      });
      expect(replay(builder.entries).outcomes.at(-1)?.outcome).toBe("accepted");
    },
  );

  it("rejects a solo plan after an activated team upgrade, even when the human replans", () => {
    const builder = planning();
    propose(builder, teamPlan());
    lock(builder, [], [MAC]);
    decision(builder, "plan.approved");
    append(builder, {
      type: "lease.claimed",
      actor: VPS,
      payload: { item: "W1", attempt_id: "att_test", branch: workBranch(T1, "W1", 1) },
      pre: { item: "W1", expected_epoch: 0 },
    });
    append(builder, {
      type: "work.failed",
      actor: VPS,
      payload: {
        item: "W1",
        epoch: 1,
        class: "budget_exceeded",
        detail: "Invocation budget spent",
      },
      pre: { item: "W1" },
    });
    expect(task(builder)).toMatchObject({ mode: "team", status: "escalated" });
    append(builder, {
      type: "human.decided",
      actor: "human",
      payload: { decision: "replan" },
    });
    expect(
      replay(builder.entries).outcomes.every((outcome) => outcome.outcome === "accepted"),
    ).toBe(true);
    expect(task(builder)).toMatchObject({ mode: "team", status: "planning", review_rounds: 0 });

    const before = task(builder);
    propose(builder, samplePlan({ version: 2, parent_version: 1 }));
    expect(replay(builder.entries).outcomes.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_plan",
    });
    expect(task(builder)).toEqual(before);
    propose(builder, teamPlan({ version: 2, parent_version: 1 }));
    expect(task(builder)).toMatchObject({
      mode: "team",
      status: "reviewing",
      current_plan_version: 2,
    });
    expect(replay(builder.entries).outcomes.at(-1)?.outcome).toBe("accepted");
  });

  it("rejects a solo proposal for a task explicitly created in team mode", () => {
    const builder = planning("team");
    const before = task(builder);
    propose(builder);
    expect(replay(builder.entries).outcomes.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_plan",
    });
    expect(task(builder)).toEqual(before);
  });

  it.each([2, 3, 4])("rejects a solo plan containing %i items", (count) => {
    const builder = planning();
    const before = task(builder);
    const first = samplePlan().items[0];
    if (!first) throw new Error("fixture item missing");
    const items = Array.from({ length: count }, (_, index) => ({
      ...first,
      id: `W${index + 1}`,
      depends_on: index === 0 ? [] : [`W${index}`],
    }));
    propose(builder, samplePlan({ items, stack_order: items.map((item) => item.id) }));
    expect(replay(builder.entries).outcomes.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_plan",
    });
    expect(task(builder)).toEqual(before);
  });

  it("allows a one-item team plan with four distinct registered reviewers for a solo task", () => {
    const builder = planning();
    const reviewers = [MAC, "mac.coding.2", "vps.coding.2", "mac.coding.3"];
    for (const actor of reviewers.slice(1)) {
      builder.append({ type: "agent.registered", actor, payload: agentRegistered() });
    }
    append(builder, {
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(samplePlan({ mode: "team" }), reviewers),
    });
    expect(replay(builder.entries).outcomes.at(-1)?.outcome).toBe("accepted");
    expect(task(builder)).toMatchObject({
      mode: "solo",
      status: "reviewing",
      plans: { "1": { reviewers, locked: null } },
    });
  });
});

describe("plan semantic validation", () => {
  const invalid: [string, (payload: PayloadOf<"plan.proposed">) => void][] = [
    [
      "skipped version",
      (p) => {
        p.version = 2;
      },
    ],
    [
      "wrong parent",
      (p) => {
        p.parent_version = 1;
      },
    ],
    [
      "embedded task mismatch",
      (p) => {
        p.plan.task_id = T2;
      },
    ],
    [
      "embedded version mismatch",
      (p) => {
        p.plan.version = 2;
        p.plan.parent_version = 1;
      },
    ],
    [
      "base commit mismatch",
      (p) => {
        p.base_commit = fakeSha("other-base");
      },
    ],
    [
      "repo mismatch",
      (p) => {
        p.plan.base.repo = "another-repo";
      },
    ],
    [
      "team plan without reviewers",
      (p) => {
        p.plan.mode = "team";
      },
    ],
    [
      "unregistered assignee",
      (p) => {
        if (p.plan.items[0]) p.plan.items[0].assignee = "mac.coding.2";
      },
    ],
    [
      "solo reviewers",
      (p) => {
        p.reviewers = [MAC];
      },
    ],
  ];
  it.each(invalid)("rejects %s without storing a plan", (_name, mutate) => {
    const builder = planning();
    const payload = planProposed();
    mutate(payload);
    payload.plan_hash = contentHash(payload.plan);
    append(builder, { type: "plan.proposed", actor: VPS, payload });
    expect(replay(builder.entries).outcomes.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_plan",
    });
    expect(task(builder)).toMatchObject({
      status: "planning",
      rev: 1,
      plans: {},
      current_plan_version: null,
    });
  });

  it.each(
    [[], [VPS], ["mac.coding.2"], [MAC, MAC]].flatMap((reviewers) =>
      (["solo", "team"] as const).map((mode) => ({ mode, reviewers })),
    ),
  )("rejects invalid team reviewer set %j", ({ mode, reviewers }) => {
    const builder = planning(mode);
    const before = task(builder);
    append(builder, {
      type: "plan.proposed",
      actor: VPS,
      payload: planProposed(teamPlan(), reviewers),
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("invalid_plan");
    expect(task(builder)).toEqual(before);
  });

  it("recomputes the plan content hash", () => {
    const builder = planning();
    append(builder, {
      type: "plan.proposed",
      actor: VPS,
      payload: { ...planProposed(), plan_hash: `sha256:${"f".repeat(64)}` },
    });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("plan_hash_mismatch");
    expect(task(builder).plans).toEqual({});
  });

  it.each(["review.submitted", "plan.locked", "plan.approved", "plan.rejected"] as const)(
    "checks the payload's exact plan identity for %s",
    (type) => {
      for (const field of ["plan_version", "plan_hash"] as const) {
        const builder = planning("team");
        propose(builder, teamPlan());
        if (type === "plan.approved" || type === "plan.rejected") lock(builder, [], [MAC]);
        const record = task(builder).plans["1"];
        if (!record) throw new Error("fixture plan missing");
        const identity = {
          plan_version: field === "plan_version" ? 2 : 1,
          plan_hash: field === "plan_hash" ? `sha256:${"f".repeat(64)}` : record.plan_hash,
        };
        if (type === "review.submitted")
          append(builder, {
            type,
            actor: MAC,
            payload: { ...identity, verdict: "approve", blockers: [], suggestions: [] },
          });
        else if (type === "plan.locked")
          append(builder, {
            type,
            actor: VPS,
            payload: { ...identity, overrides: [], missing_reviews: [MAC] },
          });
        else append(builder, { type, actor: "human", payload: identity });
        expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("plan_changed");
      }
    },
  );

  it("rejects all plan changes after execution starts", () => {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder);
    lock(builder);
    decision(builder, "plan.approved");
    const before = task(builder);
    propose(builder, teamPlan({ version: 2, parent_version: 1 }));
    review(builder);
    lock(builder);
    decision(builder, "plan.approved");
    decision(builder, "plan.rejected");
    expect(
      replay(builder.entries)
        .outcomes.slice(-5)
        .map((outcome) => outcome.reason),
    ).toEqual(Array(5).fill("bad_task_state"));
    expect(task(builder)).toEqual(before);
  });
});

describe("activatePlan carry-over (D7)", () => {
  function completed(status: "delivered" | "merged"): TaskState {
    const builder = planning("team");
    propose(builder, teamPlan());
    review(builder);
    lock(builder);
    decision(builder, "plan.approved");
    const t = task(builder);
    const item = t.items.W1;
    const record = t.plans["1"];
    if (!item || !record) throw new Error("fixture item or plan missing");
    item.status = status;
    item.delivered = {
      epoch: 3,
      branch: "branch",
      head_sha: fakeSha("head"),
      submit: {
        method: "pr",
        state: "opened",
        pr_url: "https://example.invalid/pr/1",
        pr_number: 1,
      },
      check_runs: [],
      seq: 8,
    };
    item.merged =
      status === "merged" ? { pr_number: 1, merge_sha: fakeSha("merge"), seq: 9 } : null;
    item.attempts_this_plan = 2;
    t.epochs.W1 = 3;
    t.barrier = {
      id: "B10",
      opened_seq: 10,
      closed_seq: 11,
      requests: [],
      awaiting: [],
      checkpointed: [],
      escalate: false,
    };
    t.escalation = { reason: "replans", seq: 10 };
    const next = teamPlan({ version: 2, parent_version: 1 });
    t.plans["2"] = {
      ...structuredClone(record),
      version: 2,
      plan: next,
      plan_hash: contentHash(next),
    };
    t.current_plan_version = 2;
    return t;
  }

  it.each(["delivered", "merged"] as const)(
    "preserves unchanged %s work and unblocks its successor",
    (status) => {
      const t = completed(status);
      const delivery = structuredClone(t.items.W1?.delivered);
      const merge = structuredClone(t.items.W1?.merged);
      activatePlan(t, 2, 12);
      expect(t).toMatchObject({
        active_plan_version: 2,
        status: "executing",
        last_seq: 12,
        barrier: null,
        escalation: null,
        epochs: { W1: 3 },
        items: {
          W1: { status, delivered: delivery, merged: merge, attempts_this_plan: 0, lease: null },
          W2: { status: "ready" },
        },
      });
    },
  );

  const changes: [string, (item: PlanItem) => void][] = [
    [
      "title",
      (item) => {
        item.title = "Changed";
      },
    ],
    [
      "assignee",
      (item) => {
        item.assignee = MAC;
      },
    ],
    [
      "touches",
      (item) => {
        item.touches = ["src/other/"];
      },
    ],
    [
      "acceptance",
      (item) => {
        item.acceptance = [{ kind: "check", name: "other" }];
      },
    ],
    [
      "requires",
      (item) => {
        item.requires = ["xcode"];
      },
    ],
  ];
  it.each(changes)("rebuilds completed work when %s changes", (_name, mutate) => {
    const t = completed("delivered");
    const next = t.plans["2"]?.plan.items[0];
    if (!next) throw new Error("fixture item missing");
    mutate(next);
    activatePlan(t, 2, 12);
    expect(t.items.W1).toMatchObject({
      status: "ready",
      delivered: null,
      merged: null,
      attempts_this_plan: 0,
    });
    expect(t.items.W2?.status).toBe("blocked");
    expect(t.epochs.W1).toBe(3);
  });

  it("rebuilds a completed item when its dependencies change", () => {
    const t = completed("merged");
    const record = t.plans["2"];
    if (!record) throw new Error("fixture plan missing");
    record.plan.stack_order = ["W2", "W1"];
    for (const item of record.plan.items) item.depends_on = item.id === "W2" ? [] : ["W2"];
    activatePlan(t, 2, 12);
    expect(t.items.W1).toMatchObject({ status: "blocked", delivered: null, merged: null });
    expect(t.items.W2?.status).toBe("ready");
  });
});
