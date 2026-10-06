import type { EventId, Sha, TaskId } from "./ids.js";
import type { State } from "./reducer/state.js";
import {
  EVENT_SCHEMA,
  type EventType,
  type PayloadOf,
  type Pre,
  parseEvent,
  type SkepEvent,
} from "./schemas/events.js";

// Indexing a concrete map preserves PayloadOf<T> while avoiding Extract's inferred invariance:
// a draft of one event type must be usable as the result of the general Intent contract.
type DraftPayloads = { [T in EventType]: PayloadOf<T> };

export interface EventDraft<T extends EventType = EventType> {
  type: T;
  task_id: TaskId | null;
  actor: string;
  pre: Pre;
  payload: DraftPayloads[T];
}

export type Intent = (state: State) => EventDraft | null;

export class EventDraftError extends Error {
  constructor(message: string) {
    super(`Cannot finalize event draft: ${message}`);
    this.name = "EventDraftError";
  }
}

export function draft<T extends EventType>(
  type: T,
  taskId: TaskId | null,
  actor: string,
  payload: PayloadOf<T>,
  pre: Pre,
): EventDraft<T>;
export function draft(
  type: EventType,
  taskId: TaskId | null,
  actor: string,
  payload: PayloadOf<EventType>,
  pre: Pre,
): EventDraft {
  return { type, task_id: taskId, actor, payload, pre };
}

export function finalizeEvent(
  eventDraft: EventDraft,
  metadata: { event_id: EventId; observed_tip: Sha; created_at: string },
): SkepEvent {
  const parsed = parseEvent({
    ...eventDraft,
    ...metadata,
    schema: EVENT_SCHEMA,
    lang: "en",
  });
  if (!parsed.ok) throw new EventDraftError(parsed.error);
  return parsed.event;
}
