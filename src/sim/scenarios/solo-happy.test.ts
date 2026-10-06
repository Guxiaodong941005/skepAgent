import { describe, expect, it } from "vitest";
import { runScenario } from "../runner.js";

describe("production daemon happy scenarios", () => {
  it.each(["solo-happy", "team-stacked"])(
    "delivers and finishes %s without invariant violations",
    async (name) => {
      const result = await runScenario(name, 601);
      expect(result.violations).toEqual([]);
      expect(result.finalTip).toMatch(/^[a-f0-9]{40}$/);
    },
    120_000,
  );
  it("replays the same seed to the same tip", async () => {
    const first = await runScenario("solo-happy", 42);
    const second = await runScenario("solo-happy", 42);
    expect(first.finalTip).toBe(second.finalTip);
  }, 120_000);
});
