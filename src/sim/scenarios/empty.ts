import type { Scenario } from "./index.js";

/** Two idle nodes still exercise signed heartbeats and polling (§13.3), without events on main. */
export const empty: Scenario = {
  name: "empty",
  devices: ["mac", "vps"],
  steps: 12,
  setup(world) {
    world.startTicks();
  },
};
