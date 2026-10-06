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
