import type { Scenario } from "./index.js";
import { replanScenario } from "./replan-once.js";

export const missingCheckpoint: Scenario = {
  name: "missing-checkpoint",
  devices: ["mac", "vps"],
  steps: 48,
  setup: (world) => replanScenario(world, 1, true),
};
