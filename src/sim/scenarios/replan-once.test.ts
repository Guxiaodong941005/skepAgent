import { describe, expect, it } from "vitest";
import { runScenario } from "../runner.js";
import { SimWorld } from "../world.js";
import { TASK } from "./claim-race.js";
import { getScenario } from "./index.js";

const count = process.env.SKEP_SIM_SEEDS === undefined ? 3 : Number(process.env.SKEP_SIM_SEEDS);
if (
  !Number.isSafeInteger(count) ||
  count <= 0 ||
  (process.env.SKEP_SIM_SEEDS !== undefined && String(count) !== process.env.SKEP_SIM_SEEDS)
)
  throw new RangeError("SKEP_SIM_SEEDS must be a positive integer, such as 3 or 50.");
const seeds = Array.from({ length: count }, (_, index) => index);

describe.each(["replan-once", "replan-escalate", "missing-checkpoint"])(
  "%s production replan scenario",
  (name) => {
    it.concurrent.each(seeds)(
      "passes all outcomes and invariants for seed %i",
      async (seed) => {
        const scenario = getScenario(name);
        const world = await SimWorld.create({ seed, devices: scenario.devices });
        try {
          await world.scheduler.execute(() => scenario.setup(world));
          await world.run(scenario.steps);
          await world.check();
          const task = world.node("mac").state.tasks[TASK];
          expect(world.violations).toEqual([]);
          expect(await world.finalTip()).toMatch(/^[a-f0-9]{40}$/);
          expect(world.scheduler.steps).toBeGreaterThan(0);
          if (name === "replan-once") {
            expect(task).toMatchObject({
              status: "delivered",
              replan_count: 1,
              active_plan_version: 2,
            });
            expect(task?.items.W1?.delivered?.epoch).toBe(2);
            expect(world.scheduler.trace.some((step) => step.label === "resume-higher-epoch")).toBe(
              true,
            );
          } else if (name === "replan-escalate") {
            expect(task).toMatchObject({
              status: "escalated",
              replan_count: 3,
              escalation: { reason: "replans" },
            });
            expect(task?.barrier?.closed_seq).not.toBeNull();
            expect(world.scheduler.trace.some((step) => step.label === "settled-replan-3")).toBe(
              true,
            );
          } else {
            expect(task).toMatchObject({ status: "replanning", replan_count: 1 });
            expect(task?.items.W1).toMatchObject({ status: "unknown", lease: null });
            expect(world.scheduler.trace.some((step) => step.label === "barrier-deadline")).toBe(
              true,
            );
          }
        } finally {
          await world.close();
        }
      },
      120_000,
    );
  },
);

it("replays the same replan seed to the same signed tip", async () => {
  const first = await runScenario("replan-once", 42);
  const second = await runScenario("replan-once", 42);
  expect(first.finalTip).toBe(second.finalTip);
}, 120_000);
