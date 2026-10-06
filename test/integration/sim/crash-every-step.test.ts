import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTEMPT_STEPS } from "../../../src/exec/attempt.js";
import {
  CRASH_CASES,
  crashEveryStep,
  crashEveryStepScenario,
  crashOutcomes,
} from "../../../src/sim/scenarios/crash-every-step.js";
import { SimWorld } from "../../../src/sim/world.js";

describe("crash-every-step", () => {
  let world: SimWorld;
  beforeAll(async () => {
    world = await SimWorld.create({ seed: 42, devices: crashEveryStep.devices });
    await world.scheduler.execute(() => crashEveryStep.setup(world));
    await world.run(crashEveryStep.steps);
  }, 240_000);
  afterAll(async () => {
    await world?.close();
  });

  it("crashes at every attempt step and every external publication boundary", () => {
    const points = crashOutcomes(world).map((outcome) => outcome.point);
    expect(points).toEqual(CRASH_CASES.map((point) => point.step));
    for (const step of ATTEMPT_STEPS) expect(points).toContain(step);
    expect(world.violations).toEqual([]);
  });

  it.each(CRASH_CASES.map((point, index) => ({ ...point, index })))(
    "recovers $step ($mode/$phase) without duplicate side effects",
    ({ index, step }) => {
      const outcome = crashOutcomes(world)[index];
      expect(outcome?.point).toBe(step);
      expect(outcome?.status).toMatch(/^(delivered_published|failed|checkpointed|stale)$/);
      expect(outcome?.pushes).toBeLessThanOrEqual(1);
      expect(outcome?.prs).toBeLessThanOrEqual(1);
      expect(Object.values(outcome?.invocations ?? {}).every((count) => count === 1)).toBe(true);
    },
  );

  it("fails unknown invocations and checks while completing known outcomes", () => {
    const unknown = new Set([
      "invocation_started",
      "invoked",
      "checks_started",
      "check_started",
      "check_run",
      "fixup",
    ]);
    for (const [index, point] of CRASH_CASES.entries()) {
      const expected =
        point.mode === "checkpoint"
          ? "checkpointed"
          : point.mode === "stale"
            ? "stale"
            : point.mode === "failure" ||
                point.mode === "secret" ||
                unknown.has(point.step) ||
                (point.step === "checks" && point.phase === undefined)
              ? "failed"
              : "delivered_published";
      expect(crashOutcomes(world)[index]?.status, `${point.step}/${point.mode}`).toBe(expected);
    }
  });

  it.each([0, 1, 2])(
    "recovers ambiguous external effects for seed %i",
    async (seed) => {
      const scenario = crashEveryStepScenario(
        CRASH_CASES.filter((point) => point.step.endsWith("_effect")),
      );
      const seeded = await SimWorld.create({ seed, devices: scenario.devices });
      try {
        await seeded.scheduler.execute(() => scenario.setup(seeded));
        await seeded.check();
        expect(seeded.violations).toEqual([]);
        expect(crashOutcomes(seeded).map((outcome) => outcome.status)).toEqual([
          "delivered_published",
          "delivered_published",
          "delivered_published",
        ]);
      } finally {
        await seeded.close();
      }
    },
    60_000,
  );
});
