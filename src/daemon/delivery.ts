import type { CodeHost } from "../codehost/types.js";
import type { Intent } from "../core/intents.js";
import type { State, TaskState } from "../core/reducer/state.js";
import type { ChecksRunner } from "../exec/checks.js";
import type { CodeMirror } from "../exec/worktree.js";
import type { GitRunner } from "../git/runner.js";
import type { Clock } from "../util/clock.js";
import type { Slot } from "./slots.js";

export interface DeliveryDutyDependencies {
  clock: Clock;
  git: GitRunner;
  mirror(slot: Slot): CodeMirror;
  checks(slot: Slot): ChecksRunner;
  codeHost(slot: Slot): CodeHost;
  notify(message: string): Promise<void>;
}

/** SK-606 fills this hook, including D14 verification and observation of human merges. */
export interface DeliveryDutyContext {
  state: State;
  task: TaskState;
  slot: Slot;
  nowMonoMs: number;
  publisher: { publish(intent: Intent): Promise<unknown> };
}
export type DeliveryDuty = (context: DeliveryDutyContext) => Promise<void>;
export const deliveryDuty: DeliveryDuty = async () => {};
export function createDeliveryDuty(_deps: DeliveryDutyDependencies): DeliveryDuty {
  return deliveryDuty;
}
