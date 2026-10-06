import type { Intent } from "../core/intents.js";
import type { State, TaskState } from "../core/reducer/state.js";
import type { AttemptRunner } from "../exec/attempt.js";
import type { Journal } from "../exec/journal.js";
import type { Clock } from "../util/clock.js";
import type { Slot } from "./slots.js";

export interface ReplanDutyDependencies {
  clock: Clock;
  journal(slot: Slot): Journal;
  notify(message: string): Promise<void>;
}

/** SK-605 fills this hook; interruption and checkpoints use the existing AttemptRunner. */
export interface ReplanDutyContext {
  state: State;
  task: TaskState;
  slot: Slot;
  nowMonoMs: number;
  publisher: { publish(intent: Intent): Promise<unknown> };
  attempt: Pick<AttemptRunner, "interrupt">;
}
export type ReplanDuty = (context: ReplanDutyContext) => Promise<void>;
export const replanDuty: ReplanDuty = async () => {};
export function createReplanDuty(_deps: ReplanDutyDependencies): ReplanDuty {
  return replanDuty;
}
