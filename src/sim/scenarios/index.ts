import type { SimDeviceOptions, SimWorld } from "../world.js";
import { empty } from "./empty.js";

export interface Scenario {
  name: string;
  devices: readonly (string | SimDeviceOptions)[];
  steps: number;
  setup(world: SimWorld): void | Promise<void>;
}

export const scenarios: Readonly<Record<string, Scenario>> = { empty };

export class UnknownScenarioError extends Error {
  constructor(name: string) {
    super(
      `Unknown simulation scenario ${JSON.stringify(name)}; available: ${Object.keys(scenarios).join(", ")}`,
    );
    this.name = "UnknownScenarioError";
  }
}

export function getScenario(name: string): Scenario {
  if (!Object.hasOwn(scenarios, name)) throw new UnknownScenarioError(name);
  const scenario = scenarios[name];
  if (!scenario) throw new UnknownScenarioError(name);
  return scenario;
}
