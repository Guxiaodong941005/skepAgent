import type { Scenario } from "./index.js";
import { daemonHappyScenario } from "./solo-happy.js";

export const teamStacked: Scenario = {
  name: "team-stacked",
  devices: ["mac", "vps"],
  steps: 60,
  setup: (world) => daemonHappyScenario(world, true),
};
