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
} from "../../../test/helpers/log-builder.js";
import { randomLog } from "../../../test/helpers/random-log.js";
import { canonicalJson } from "../canonical.js";
import type { LogEntry } from "../log.js";
import type { Plan } from "../schemas/plan.js";
import { checkInvariants } from "./invariants.js";
import { applyEntry, replay } from "./replay.js";

/**
 * Property tests for the reducer (ARCHITECTURE §14, SK-304): seeded random logs, full replay equal
 * to incremental replay, invariants 2–4, 6, 8 and 9, and forged entries that change nothing.
 * One thousand logs is the acceptance bar; a failure names the seed so it can be replayed alone.
 */

const LOGS = Number(process.env.SKEP_PROPERTY_LOGS ?? 1000);

/**
 * The SK-304 review repro: solo plan v1 approved, a human replan with nothing leased, then three
 * proposals each `plan.rejected`. The third rejection escalates (`review_rounds` 3 > 2) and
 * `resume_with_plan` returns the task to `executing` with the counter still over budget (D12).
 */
function reviewRoundLog(): LogBuilder {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  const created = taskCreated();
  created.budgets.review_rounds = 2;
  builder.append({ type: "task.created", actor: "human", payload: created });

  const propose = (version: number): void => {
    const current = replay(builder.entries).tasks[T1];
    if (!current) throw new Error("fixture task missing");
    const plan: Plan = samplePlan({ version, parent_version: version === 1 ? null : version - 1 });
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      pre: { task_rev: current.rev, owner_gen: current.owner_gen },
      payload: planProposed(plan),
    });
  };
  const reject = (): void => {
    const current = replay(builder.entries).tasks[T1];
    const record = current?.plans[String(current.current_plan_version)];
    if (!current || !record) throw new Error("fixture plan missing");
    builder.append({
      type: "plan.rejected",
      actor: "human",
      pre: { task_rev: current.rev, plan_version: record.version, plan_hash: record.plan_hash },
      payload: {
        plan_version: record.version,
        plan_hash: record.plan_hash,
        note: "Needs changes.",
      },
    });
  };

  propose(1);
  const approved = replay(builder.entries).tasks[T1];
  const record = approved?.plans["1"];
  if (!approved || !record) throw new Error("fixture plan missing");
  builder.append({
    type: "plan.approved",
    actor: "human",
    pre: { task_rev: approved.rev, plan_version: 1, plan_hash: record.plan_hash },
    payload: { plan_version: 1, plan_hash: record.plan_hash },
  });
  const executing = replay(builder.entries).tasks[T1];
  if (!executing) throw new Error("fixture task missing");
  builder.append({
    type: "replan.requested",
    actor: "human",
    pre: { task_rev: executing.rev },
    payload: { summary: "Start over.", evidence: [], item: null },
  });
  for (const version of [2, 3, 4]) {
    propose(version);
    reject();
  }
  const escalated = replay(builder.entries).tasks[T1];
  if (!escalated) throw new Error("fixture task missing");
  builder.append({
    type: "human.decided",
    actor: "human",
    pre: { task_rev: escalated.rev },
    payload: { decision: "resume_with_plan", note: "Continue with the active plan." },
  });
  return builder;
}

/**
 * Solo plan approved and claimed, then two `replan.requested` with budget 1. Nothing else is
 * leased, so the first barrier settles at once and the second opens an escalate barrier that
 * settles into `escalated` (D5, D20).
 */
function overBudgetReplanLog(): LogBuilder {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  const created = taskCreated();
  created.budgets.replans = 1;
  builder.append({ type: "task.created", actor: "human", payload: created });

  const proposeAndApprove = (version: number): void => {
    const current = replay(builder.entries).tasks[T1];
    if (!current) throw new Error("fixture task missing");
    const plan: Plan = samplePlan({
      version,
      parent_version: version === 1 ? null : version - 1,
      changes_from_parent: version === 1 ? null : "Same item, another attempt.",
    });
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      pre: { task_rev: current.rev, owner_gen: current.owner_gen },
      payload: planProposed(plan),
    });
    const proposed = replay(builder.entries).tasks[T1];
    const record = proposed?.plans[String(version)];
    if (!proposed || !record) throw new Error("fixture plan missing");
    builder.append({
      type: "plan.approved",
      actor: "human",
      pre: { task_rev: proposed.rev, plan_version: version, plan_hash: record.plan_hash },
      payload: { plan_version: version, plan_hash: record.plan_hash },
    });
  };

  proposeAndApprove(1);
  claim(builder, 1, 0, "att_01");
  // The first request is inside the budget, so its barrier does not escalate and the checkpoint
  // settles it into `replanning`. The second request is over budget, so it escalates, and its
  // checkpoint settles the barrier into `escalated` (§5.5).
  for (const version of [1, 2]) {
    const current = replay(builder.entries).tasks[T1];
    if (!current) throw new Error("fixture task missing");
    builder.append({
      type: "replan.requested",
      // The human needs no evidence (PRD §9.9); the budget rule does not depend on who asks.
      actor: "human",
      pre: { task_rev: current.rev },
      payload: { summary: "The plan no longer fits.", evidence: [], item: "W1" },
    });
    checkpoint(builder);
    if (version === 1) {
      const open = replay(builder.entries).tasks[T1];
      const lease = open?.items.W1?.lease;
      if (!open?.barrier || !lease) throw new Error("fixture barrier missing");
      builder.append({
        type: "checkpoint.recorded",
        actor: VPS,
        pre: { task_rev: open.rev, item: "W1" },
        payload: {
          item: "W1",
          epoch: lease.epoch,
          barrier_id: open.barrier.id,
          snapshot: {
            schema: "skep.snapshot/v1",
            item: "W1",
            epoch: lease.epoch,
            attempt_id: lease.attempt_id,
            branch: lease.branch,
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            pushed: true,
            invocation_state: "interrupted",
            diffstat: { files: 1, insertions: 1, deletions: 0 },
            files_changed: ["src/theme/"],
            check_runs: [],
            agent_note: null,
          },
        },
      });
      proposeAndApprove(2);
      claim(builder, 2, 1, "att_02");
    }
  }
  return builder;
}

function claim(builder: LogBuilder, version: number, epoch: number, attempt: string): void {
  const task = replay(builder.entries).tasks[T1];
  const plan = task?.plans[String(version)];
  if (!task || !plan) throw new Error("fixture plan missing");
  builder.append({
    type: "lease.claimed",
    actor: VPS,
    pre: {
      task_rev: task.rev,
      plan_version: version,
      plan_hash: plan.plan_hash,
      item: "W1",
      expected_epoch: epoch,
    },
    payload: { item: "W1", attempt_id: attempt, branch: `skep/T-20261005-7f3a/W1/e${epoch + 1}` },
  });
}

/** Record the checkpoint the open barrier is waiting on, so it settles. */
function checkpoint(builder: LogBuilder): void {
  const task = replay(builder.entries).tasks[T1];
  const lease = task?.items.W1?.lease;
  if (!task?.barrier || !lease) throw new Error("fixture barrier missing");
  builder.append({
    type: "checkpoint.recorded",
    actor: VPS,
    pre: { task_rev: task.rev, item: "W1" },
    payload: {
      item: "W1",
      epoch: lease.epoch,
      barrier_id: task.barrier.id,
      snapshot: {
        schema: "skep.snapshot/v1",
        item: "W1",
        epoch: lease.epoch,
        attempt_id: lease.attempt_id,
        branch: lease.branch,
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        pushed: true,
        invocation_state: "interrupted",
        diffstat: { files: 1, insertions: 1, deletions: 0 },
        files_changed: ["src/theme/"],
        check_runs: [],
        agent_note: null,
      },
    },
  });
}

function domainJson(entries: LogEntry[]): string {
  const state = replay(entries);
  const { outcomes: _outcomes, seen_event_ids: _seen, tip: _tip, seq: _seq, ...domain } = state;
  return canonicalJson(domain);
}

describe("reducer property tests", () => {
  it("covers verification failure, human decisions, full-carry replans and review-round escalation", () => {
    const seen = {
      verifiedFailed: false,
      decided: false,
      carried: false,
      reviewEscalated: false,
      resumedOverBudget: false,
    };
    const covered = (): boolean => Object.values(seen).every(Boolean);
    for (let seed = 0; seed < 200 && !covered(); seed++) {
      const log = randomLog(seed, { events: 40 });
      const state = replay(log.entries);
      for (const task of Object.values(state.tasks)) {
        if (task.escalation?.reason === "verification_failed") seen.verifiedFailed = true;
      }
      if (
        state.outcomes.some(
          (outcome) => outcome.type === "human.decided" && outcome.outcome === "accepted",
        )
      ) {
        seen.decided = true;
      }
      // A replan that carries every item over activates straight to delivered or done (D15):
      // the plan version approved after a replan.requested has no item left that is not already
      // delivered or merged, because nothing was leased under it.
      for (const task of Object.values(state.tasks)) {
        const replanned = state.outcomes.some(
          (outcome) =>
            outcome.task_id === task.task_id &&
            outcome.type === "replan.requested" &&
            outcome.outcome === "accepted",
        );
        if (!replanned || task.active_plan_version === null) continue;
        const items = Object.values(task.items);
        const finished =
          items.length > 0 &&
          items.every((item) => item.status === "delivered" || item.status === "merged") &&
          items.every((item) => item.attempts_this_plan === 0);
        if (finished && (task.status === "delivered" || task.status === "done"))
          seen.carried = true;
        // A review-round escalation followed by resume_with_plan leaves review_rounds over budget
        // while the task is back at work (D12, D20). Both must show up in the generated logs.
        if (task.escalation?.reason === "review_rounds") seen.reviewEscalated = true;
        if (
          task.review_rounds > task.budgets.review_rounds &&
          task.status !== "escalated" &&
          task.status !== "cancelled"
        ) {
          seen.resumedOverBudget = true;
        }
      }
    }
    expect(seen).toEqual({
      verifiedFailed: true,
      decided: true,
      carried: true,
      reviewEscalated: true,
      resumedOverBudget: true,
    });
  });

  it("accepts a review-round escalation resumed with the same plan (D20)", () => {
    const builder = reviewRoundLog();
    const state = replay(builder.entries);
    const task = state.tasks[T1];
    expect(task).toMatchObject({
      status: "executing",
      review_rounds: 3,
      escalation: null,
    });
    expect(checkInvariants(builder.entries, state)).toEqual([]);

    // The same log if the third rejection had not escalated: drop the resume and rewrite that
    // rejection's outcome so review_rounds crosses the budget while the task stays planning.
    const rejection = [...state.outcomes]
      .reverse()
      .find((outcome) => outcome.type === "plan.rejected");
    if (!rejection) throw new Error("fixture rejection missing");
    const prefix = builder.entries.filter((entry) => entry.seq <= rejection.seq);
    const stuck = replay(prefix);
    const taskStuck = stuck.tasks[T1];
    if (!taskStuck) throw new Error("fixture task missing");
    taskStuck.status = "planning";
    taskStuck.escalation = null;
    const violations = checkInvariants(prefix, stuck);
    expect(violations.map((violation) => violation.code)).toContain("review_budget");
  });

  it("flags an over-budget replan whose barrier does not escalate (D20)", () => {
    // Legal first: the second replan.requested opens a barrier with `escalate: true`. The
    // constructed violation is that same step with the flag cleared — the state invariant 6 reads
    // for the last entry — so the prefix has to end on the request that crosses the budget.
    const builder = overBudgetReplanLog();
    const state = replay(builder.entries);
    expect(state.tasks[T1]?.replan_count).toBeGreaterThan(state.tasks[T1]?.budgets.replans ?? 0);
    expect(checkInvariants(builder.entries, state)).toEqual([]);

    const second = state.outcomes.filter(
      (outcome) => outcome.type === "replan.requested" && outcome.outcome === "accepted",
    )[1];
    if (!second) throw new Error("fixture replan requests missing");
    const prefix = builder.entries.filter((entry) => entry.seq <= second.seq);
    const broken = replay(prefix);
    const task = broken.tasks[T1];
    if (!task?.barrier) throw new Error("fixture barrier missing");
    expect(task.barrier.escalate).toBe(true);
    task.barrier.escalate = false;

    const violations = checkInvariants(prefix, broken);
    expect(violations.map((violation) => violation.code)).toEqual(["replan_budget"]);
  });

  it("flags an escalate barrier that settles into replanning (D20)", () => {
    // An escalate barrier waits out its leases and may only settle into `escalated` (§5.5).
    // Rewriting that status to `replanning` is the settle the review asked for, and it must be
    // reported as `replan_budget_settle`.
    const builder = overBudgetReplanLog();
    const state = replay(builder.entries);
    const task = state.tasks[T1];
    if (!task) throw new Error("fixture task missing");
    expect(task.status).toBe("escalated");
    expect(task.barrier?.escalate).toBe(true);

    task.status = "replanning";
    const violations = checkInvariants(builder.entries, state);
    expect(violations.map((violation) => violation.code)).toContain("replan_budget_settle");
    expect(violations.every((violation) => violation.invariant === 6)).toBe(true);
  });

  it(`holds replay equality and invariants 2–4, 6, 8, 9 across ${LOGS} logs`, () => {
    for (let seed = 0; seed < LOGS; seed++) {
      const log = randomLog(seed);
      const full = replay(log.entries);
      const incremental = log.entries.slice(1).reduce(applyEntry, replay(log.entries.slice(0, 1)));
      expect(canonicalJson(incremental), `seed ${seed}: incremental replay`).toBe(
        canonicalJson(full),
      );

      const violations = checkInvariants(log.entries, full);
      expect(violations, `seed ${seed}: ${violations.map((v) => v.detail).join("; ")}`).toEqual([]);

      for (const seq of log.forgedSeqs) {
        const withForgery = domainJson(log.entries.filter((entry) => entry.seq <= seq));
        const without = domainJson(
          log.entries.filter((entry) => entry.seq !== seq && entry.seq <= seq),
        );
        expect(withForgery, `seed ${seed}: forged seq ${seq} changed state`).toBe(without);
      }
    }
  }, 120_000);
});
