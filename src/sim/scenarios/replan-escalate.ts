import type { Scenario } from "./index.js";
import { replanScenario } from "./replan-once.js";

export const replanEscalate: Scenario = {
  name: "replan-escalate",
  devices: ["mac", "vps"],
  steps: 48,
  setup: (world) => replanScenario(world, 3),
};
