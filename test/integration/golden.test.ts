import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "../../src/core/canonical.js";
import { checkInvariants } from "../../src/core/reducer/invariants.js";
import { applyEntry, replay } from "../../src/core/reducer/replay.js";
import type { State, TaskState } from "../../src/core/reducer/state.js";
import { checkStructure } from "../../src/core/reducer/structural.js";
import { fixturePath, loadFixture, replayFixture, saveFixture } from "../helpers/golden.js";
import { buildScenarios, type Scenario } from "../helpers/golden-scenarios.js";

/**
 * Golden replay (SK-305, ARCHITECTURE §14).
 *
 * Each file in `test/fixtures/golden/` is a complete blackboard log plus the `contentHash` of the
 * state the reducer produces for it. Replaying must be deterministic, equal whether done in full
 * or one entry at a time, free of invariant violations, and byte-for-byte the log the scenario
 * script builds. The hash guards a reducer change: this file fails until someone updates it.
 *
 * Update the fixtures after an intentional reducer change with:
 *
 *   SKEP_UPDATE_GOLDEN=1 npx vitest run test/integration/golden.test.ts
 *
 * That rewrites `state_hash` and `entries` from `test/helpers/golden-scenarios.ts`. Review the
 * diff; a hash that moved without a reducer change means a scenario script changed, not the
 * protocol. There is no npm script for this on purpose.
 */

const UPDATE = process.env.SKEP_UPDATE_GOLDEN === "1";

const EXPECTED = [
  "solo",
  "team",
  "replan",
  "escalate",
  "forged",
  "verify-fail-resume",
  "review-resume",
] as const;

/**
 * The rewrite used to run in the `describe.each` body, which executes at collection time. A watch
 * or parallel run with the env var set would rewrite the fixtures once per reload (SK-305 review
 * note 3). Refuse the combination, and otherwise rewrite once in `beforeAll`.
 */
const WATCH =
  process.argv.includes("--watch") ||
  process.argv.includes("watch") ||
  process.argv.includes("dev");
if (UPDATE && WATCH) {
  throw new Error(
    "SKEP_UPDATE_GOLDEN=1 rewrites fixtures; run it with `vitest run`, not watch mode",
  );
}

function scenarioByName(name: string): Scenario {
  const scenario = buildScenarios().find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`golden scenario ${name} is not built by golden-scenarios.ts`);
  return scenario;
}

/** Rewrite one fixture from its scenario. Only called when SKEP_UPDATE_GOLDEN=1. */
function updateFixture(scenario: Scenario): void {
  saveFixture({ ...scenario, state_hash: contentHash(replay(scenario.entries)) });
}

describe("golden replay fixtures", () => {
  // Written once, here, rather than inside `describe.each`: that body re-runs for every test in
  // the case, so a watch reload would rewrite the fixtures repeatedly (SK-305 review note 3).
  // `beforeAll` is too late — the cases below read the fixtures while the file is collected.
  if (UPDATE) {
    for (const name of EXPECTED) updateFixture(scenarioByName(name));
  }

  const files = readdirSync("test/fixtures/golden")
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();

  it("pins exactly the seven required paths", () => {
    expect(files).toEqual([...EXPECTED].sort());
  });

  describe.each(EXPECTED)("%s", (name) => {
    const scenario = scenarioByName(name);
    const fixture = loadFixture(name);

    it("replays to its pinned content hash", () => {
      const { hash } = replayFixture(fixture);
      expect(hash, `${name}: set SKEP_UPDATE_GOLDEN=1 to accept this state`).toBe(
        fixture.state_hash,
      );
    });

    it("is the log the scenario script builds, replayed in full or incrementally", () => {
      expect(fixture.summary.length).toBeGreaterThan(0);
      expect(fixture.entries).toEqual(scenario.entries);
      const full = replay(fixture.entries);
      const incremental = fixture.entries
        .slice(1)
        .reduce(applyEntry, replay(fixture.entries.slice(0, 1)));
      expect(canonicalJson(incremental)).toBe(canonicalJson(full));
    });

    it("satisfies reducer invariants 2, 3, 4, 6, 8 and 9", () => {
      const state = replay(fixture.entries);
      expect(checkInvariants(fixture.entries, state)).toEqual([]);
    });
  });

  it("keeps the pinned hashes distinct, so no two paths collapse to one state", () => {
    const hashes = EXPECTED.map((name) => loadFixture(name).state_hash);
    expect(new Set(hashes).size).toBe(EXPECTED.length);
  });

  it("records the final status each path exists to pin", () => {
    const status = (name: (typeof EXPECTED)[number]): string | undefined =>
      taskOf(replayFixture(loadFixture(name)).state).status;
    expect(status("solo")).toBe("done");
    expect(status("team")).toBe("done");
    expect(status("replan")).toBe("delivered");
    expect(status("escalate")).toBe("escalated");
    expect(status("forged")).toBe("delivered");
    expect(status("verify-fail-resume")).toBe("done");
    expect(status("review-resume")).toBe("executing");
  });

  it("carries the delivered item across the replan and redelivers higher (D7, D15)", () => {
    const task = taskOf(replayFixture(loadFixture("replan")).state);
    expect(task.replan_count).toBe(1);
    expect(task.escalation).toBeNull();
    // W1 was delivered before the barrier and its definition was unchanged, so it carried over.
    expect(task.items.W1?.status).toBe("delivered");
    expect(task.items.W1?.delivered?.epoch).toBe(1);
    // The replacement item was leased again after activation, so its epoch rose.
    expect(task.items.W2).toMatchObject({ status: "delivered", delivered: { epoch: 2 } });
    expect(task.epochs).toEqual({ W1: 1, W2: 2 });
  });

  it("escalates exactly when the replan budget is exceeded (D5, D20)", () => {
    const task = taskOf(replayFixture(loadFixture("escalate")).state);
    expect(task.replan_count).toBe(2);
    expect(task.budgets.replans).toBe(1);
    expect(task.escalation?.reason).toBe("replans");
    expect(task.barrier?.escalate).toBe(true);
    expect(task.items.W1?.status).toBe("interrupted");
  });

  it("ignores every forged commit: the task is where the last good event left it", () => {
    const { state } = replayFixture(loadFixture("forged"));
    const task = taskOf(state);
    const outcomes = state.outcomes.map((outcome) => outcome.outcome);
    expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(6);
    expect(outcomes).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "invalid",
      "invalid",
      "invalid",
      "rejected",
      "rejected",
    ]);
    expect(state.outcomes.slice(-2).map((outcome) => outcome.reason)).toEqual([
      "unauthorized",
      "stale_tip",
    ]);
    expect(task.status).toBe("delivered");
    // task.created, plan.proposed, plan.approved, lease.claimed, work.delivered — nothing after.
    expect(task.rev).toBe(5);
  });

  it("walks verification failure, resume, re-verification, merge and done (D14, D15)", () => {
    const fixture = loadFixture("verify-fail-resume");
    // The failing verification is the point of the fixture: the task must have been escalated for
    // it, with the record kept, before the human resumed (D14).
    const failing = fixture.entries.find((entry, index) => {
      const prev = fixture.entries[index - 1];
      if (!prev) return false;
      const parsed = checkStructure(entry, prev.sha);
      return parsed.ok && parsed.event.type === "task.verified" && !parsed.event.payload.passed;
    });
    if (!failing) throw new Error("verify-fail-resume has no failing task.verified");
    const escalated = replay(fixture.entries.slice(0, failing.seq + 1));
    expect(taskOf(escalated)).toMatchObject({
      status: "escalated",
      escalation: { reason: "verification_failed", seq: failing.seq },
      verified: { passed: false },
    });

    const task = taskOf(replayFixture(fixture).state);
    expect(task.status).toBe("done");
    expect(task.verified).toMatchObject({ passed: true });
    // Resuming re-activates the plan and clears the escalation; the failed record is replaced.
    expect(task.escalation).toBeNull();
    expect(task.items.W1?.status).toBe("merged");
    // The resume did not grant a new epoch: the same delivery stands.
    expect(task.epochs).toEqual({ W1: 1 });
  });

  it("resumes a review-round escalation with the counter still over budget (D12, D20)", () => {
    const task = taskOf(replayFixture(loadFixture("review-resume")).state);
    expect(task.review_rounds).toBe(3);
    expect(task.budgets.review_rounds).toBe(2);
    expect(task.status).toBe("executing");
    // resume_with_plan resets neither counter and clears the escalation (D12).
    expect(task.escalation).toBeNull();
    expect(task.active_plan_version).toBe(1);
  });

  it("uses example.invalid for every recorded PR URL", () => {
    for (const name of EXPECTED) {
      const fixture = loadFixture(name);
      const urls = fixture.entries
        .flatMap((entry) => Object.values(entry.added ?? {}))
        .filter((body): body is string => body?.includes("pr_url") === true);
      for (const body of urls) expect(body).toContain("https://example.invalid/");
      for (const body of urls) expect(body).not.toContain("example.com");
    }
  });

  it("stores fixtures under test/fixtures/golden", () => {
    for (const name of EXPECTED)
      expect(fixturePath(name)).toBe(`test/fixtures/golden/${name}.json`);
  });
});

function taskOf(state: State): TaskState {
  const task = Object.values(state.tasks)[0];
  if (!task) throw new Error("golden fixture has no task");
  return task;
}
