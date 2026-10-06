import { describe, expect, it } from "vitest";
import { randomLog } from "../../../test/helpers/random-log.js";
import { canonicalJson } from "../canonical.js";
import type { LogEntry } from "../log.js";
import { checkInvariants } from "./invariants.js";
import { applyEntry, replay } from "./replay.js";

/**
 * Property tests for the reducer (ARCHITECTURE §14, SK-304): seeded random logs, full replay equal
 * to incremental replay, invariants 2–4, 6, 8 and 9, and forged entries that change nothing.
 * One thousand logs is the acceptance bar; a failure names the seed so it can be replayed alone.
 */

const LOGS = Number(process.env.SKEP_PROPERTY_LOGS ?? 1000);

function domainJson(entries: LogEntry[]): string {
  const state = replay(entries);
  const { outcomes: _outcomes, seen_event_ids: _seen, tip: _tip, seq: _seq, ...domain } = state;
  return canonicalJson(domain);
}

describe("reducer property tests", () => {
  it("covers verification failure, human decisions and full-carry replans", () => {
    const seen = { verifiedFailed: false, decided: false, carried: false };
    for (
      let seed = 0;
      seed < 120 && !(seen.verifiedFailed && seen.decided && seen.carried);
      seed++
    ) {
      const log = randomLog(seed, { events: 30 });
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
      }
    }
    expect(seen).toEqual({ verifiedFailed: true, decided: true, carried: true });
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
