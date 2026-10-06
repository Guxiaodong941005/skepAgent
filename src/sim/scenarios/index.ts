import type { SimDeviceOptions, SimWorld } from "../world.js";
import { claimRace } from "./claim-race.js";
import { clockSkew } from "./clock-skew.js";
import { crashEveryStep } from "./crash-every-step.js";
import { duplicateBoot } from "./duplicate-boot.js";
import { empty } from "./empty.js";
import { fetchFlaky } from "./fetch-flaky.js";
import { forgedCommits } from "./forged-commits.js";
import { lostAck } from "./lost-ack.js";
import { missingCheckpoint } from "./missing-checkpoint.js";
import { replanEscalate } from "./replan-escalate.js";
import { replanOnce } from "./replan-once.js";
import { sleepWakeRevoke } from "./sleep-wake-revoke.js";
import { soloHappy } from "./solo-happy.js";
import { teamStacked } from "./team-stacked.js";

export interface Scenario {
  name: string;
  devices: readonly (string | SimDeviceOptions)[];
  steps: number;
  setup(world: SimWorld): void | Promise<void>;
}

export const scenarios: Readonly<Record<string, Scenario>> = {
  empty,
  "claim-race": claimRace,
  "lost-ack": lostAck,
  "fetch-flaky": fetchFlaky,
  "forged-commits": forgedCommits,
  "sleep-wake-revoke": sleepWakeRevoke,
  "duplicate-boot": duplicateBoot,
  "clock-skew": clockSkew,
  "solo-happy": soloHappy,
  "team-stacked": teamStacked,
  "crash-every-step": crashEveryStep,
  "replan-once": replanOnce,
  "replan-escalate": replanEscalate,
  "missing-checkpoint": missingCheckpoint,
};

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
