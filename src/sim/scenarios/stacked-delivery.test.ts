import { describe, expect, it } from "vitest";
import { SimWorld } from "../world.js";
import { STACKED_TASK, stackedDelivery, stackedDeliveryOutcome } from "./stacked-delivery.js";

async function run(seed: number) {
  const world = await SimWorld.create({ seed, devices: stackedDelivery.devices });
  try {
    // The registry is owned by SK-605; this task drives its scenario directly.
    await world.scheduler.execute(() => stackedDelivery.setup(world));
    await world.run(stackedDelivery.steps);
    await world.check();
    const outcome = stackedDeliveryOutcome(world);
    expect(outcome).toMatchObject({
      statuses: ["delivered", "escalated", "delivered", "done"],
      verificationExits: [
        [1, 0],
        [0, 0],
      ],
      secondBase: `skep/${STACKED_TASK}/W1/e1`,
    });
    expect(outcome?.notifications).toHaveLength(1);
    expect(world.violations).toEqual([]);
    for (const node of world.nodes) {
      const task = node.state.tasks[STACKED_TASK];
      expect(task).toMatchObject({ status: "done", verified: { passed: true } });
      expect(task?.items.W1?.merged?.merge_sha).toBe(outcome?.mergeShas[0]);
      expect(task?.items.W2?.merged?.merge_sha).toBe(outcome?.mergeShas[1]);
    }
    return await world.finalTip();
  } finally {
    await world.close();
  }
}

describe("stacked delivery simulation", () => {
  it("delivers, fails combined verification, resumes, re-verifies and observes human merges", async () => {
    await run(606);
  }, 120_000);
  it("replays the same seed to the same signed blackboard tip", async () => {
    expect(await run(42)).toBe(await run(42));
  }, 120_000);
});
