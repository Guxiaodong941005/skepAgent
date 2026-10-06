import type { Sha } from "../core/ids.js";
import { SimInvariantError, type SimViolation } from "./invariants.js";
import { getScenario } from "./scenarios/index.js";
import { SimWorld, SimWorldError } from "./world.js";

export interface ScenarioOptions {
  steps?: number;
  root?: string;
  /** For debugging only: retain the owned world directory after a run. */
  keepArtifacts?: boolean;
}

export interface ScenarioResult {
  finalTip: Sha;
  steps: number;
  violations: SimViolation[];
}

export async function runScenario(
  name: string,
  seed: number | string,
  opts: ScenarioOptions = {},
): Promise<ScenarioResult> {
  const scenario = getScenario(name);
  const steps = opts.steps ?? scenario.steps;
  if (!Number.isSafeInteger(steps) || steps < 0)
    throw new SimWorldError("Scenario steps must be a non-negative safe integer");
  const world = await SimWorld.create({ seed, devices: scenario.devices, root: opts.root });
  try {
    try {
      await world.scheduler.execute(() => scenario.setup(world));
      await world.run(steps);
      await world.check();
    } catch (error) {
      if (!(error instanceof SimInvariantError)) throw error;
      // world.check has recorded the seed, step and log for the CLI's machine result.
    }
    return {
      finalTip: await world.finalTip(),
      steps: world.scheduler.steps,
      violations: [...world.violations],
    };
  } finally {
    if (!opts.keepArtifacts) await world.close();
  }
}
