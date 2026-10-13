/**
 * One orchestration per human request: master agent refine → (questions) → (confirm) → dispatch
 * → await the peers → master agent synthesis (docs/plans/tui-scroll-and-herdr-controller.md
 * §3.3). Pure and deterministic: the state is plain JSON and every transition is an event, so
 * the driver (`src/orchestrator/orchestrator.ts`) only performs the effect the new phase asks
 * for.
 *
 * ```
 * refining ─► (asking ─► refining)* ─► [confirming] ─► dispatching ─► awaiting ─► synthesizing ─► done
 *     └─► failed(refine)        └─► cancelled    └─► failed(dispatch)  └─► stalled   └─► done(raw)
 * ```
 * `confirming` exists only in mode `confirm`; the default `auto` (locked decision §9.1) goes
 * straight from a valid refine to `dispatching`.
 */

import type { RefineOutput } from "./schemas.js";

export type OrchestrationMode = "auto" | "confirm" | "off";
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = "auto";
/** Clarifying question rounds before the master agent must commit to a brief. */
export const MAX_QUESTION_ROUNDS = 2;

export type OrchestrationPhase =
  | "refining"
  | "asking"
  | "confirming"
  | "dispatching"
  | "awaiting"
  | "stalled"
  | "synthesizing"
  | "done"
  | "failed"
  | "cancelled";

/** How an item ended, as `itemVerdict` (src/session/master.ts) reports it. */
export type ItemVerdict = "done" | "failed" | "submit-failed" | "pending" | "declined" | "running";

export interface OrchestrationItem {
  intentId: string;
  itemId: string;
  verdict: ItemVerdict;
  repo: string;
  /** Peer device, when the status names it. */
  device?: string;
  /** The received summary (≤4000, redacted on master and peer); absent until a result. */
  summary?: string;
}

export interface OrchestrationState {
  id: string;
  mode: Exclude<OrchestrationMode, "off">;
  phase: OrchestrationPhase;
  userText: string;
  /** Human answers to the master agent's questions, in order. */
  answers: string[];
  questionRounds: number;
  /** Questions waiting for the human while `asking`. */
  questions: string[];
  refine: RefineOutput | null;
  /** The brief that is (or was) sent: the refine's, or the human's edit in `confirm` mode. */
  brief: { title: string; text: string } | null;
  intentIds: string[];
  items: OrchestrationItem[];
  synthesis: string | null;
  /** Synthesis failed: the results are shown as received instead. */
  raw: boolean;
  failure: { stage: "refine" | "dispatch" | "synthesize"; cause: string } | null;
}

export type OrchestrationEvent =
  | { type: "refined"; output: RefineOutput }
  | { type: "refineFailed"; cause: string }
  | { type: "answered"; text: string }
  | { type: "confirmed"; brief?: { title: string; text: string } }
  | { type: "cancelled" }
  | { type: "dispatched"; intentIds: string[] }
  | { type: "dispatchFailed"; cause: string }
  | { type: "itemsChanged"; items: OrchestrationItem[] }
  | { type: "summarizeNow" }
  | { type: "synthesized"; text: string }
  | { type: "synthFailed"; cause: string };

export function startOrchestration(
  id: string,
  userText: string,
  mode: Exclude<OrchestrationMode, "off">,
): OrchestrationState {
  return {
    id,
    mode,
    phase: "refining",
    userText,
    answers: [],
    questionRounds: 0,
    questions: [],
    refine: null,
    brief: null,
    intentIds: [],
    items: [],
    synthesis: null,
    raw: false,
    failure: null,
  };
}

export const TERMINAL_PHASES: ReadonlySet<OrchestrationPhase> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/** Verdicts after which the item will not change any more. `pending` waits for a human (D29). */
const FINAL_VERDICTS: ReadonlySet<ItemVerdict> = new Set([
  "done",
  "failed",
  "submit-failed",
  "declined",
]);

/** `settled`: every item final; `stalled`: none running but some wait for a human. */
export function itemsProgress(
  items: readonly OrchestrationItem[],
): "running" | "settled" | "stalled" {
  if (items.length === 0 || items.some((item) => item.verdict === "running")) return "running";
  return items.every((item) => FINAL_VERDICTS.has(item.verdict)) ? "settled" : "stalled";
}

/** Applies one event. An event that does not fit the phase leaves the state unchanged. */
export function reduceOrchestration(
  state: OrchestrationState,
  event: OrchestrationEvent,
): OrchestrationState {
  if (TERMINAL_PHASES.has(state.phase)) return state;
  if (event.type === "cancelled") {
    // A dispatched intent is the peers' now; cancelling only stops this side from waiting.
    return { ...state, phase: "cancelled" };
  }
  switch (state.phase) {
    case "refining":
      return refining(state, event);
    case "asking":
      if (event.type !== "answered") return state;
      return {
        ...state,
        phase: "refining",
        answers: [...state.answers, event.text],
        questions: [],
      };
    case "confirming":
      if (event.type !== "confirmed") return state;
      return {
        ...state,
        phase: "dispatching",
        brief: event.brief ?? state.brief,
      };
    case "dispatching":
      if (event.type === "dispatched") {
        return { ...state, phase: "awaiting", intentIds: [...event.intentIds] };
      }
      if (event.type === "dispatchFailed") {
        return { ...state, phase: "failed", failure: { stage: "dispatch", cause: event.cause } };
      }
      return state;
    case "awaiting":
    case "stalled":
      if (event.type === "summarizeNow") {
        return state.items.length === 0 ? state : { ...state, phase: "synthesizing" };
      }
      if (event.type !== "itemsChanged") return state;
      return withItems(state, event.items);
    case "synthesizing":
      if (event.type === "itemsChanged") return { ...state, items: copyItems(event.items) };
      if (event.type === "synthesized") return { ...state, phase: "done", synthesis: event.text };
      if (event.type === "synthFailed") {
        return {
          ...state,
          phase: "done",
          raw: true,
          failure: { stage: "synthesize", cause: event.cause },
        };
      }
      return state;
    default:
      return state;
  }
}

function refining(state: OrchestrationState, event: OrchestrationEvent): OrchestrationState {
  if (event.type === "refineFailed") {
    return { ...state, phase: "failed", failure: { stage: "refine", cause: event.cause } };
  }
  if (event.type !== "refined") return state;
  const output = event.output;
  const questions = output.questions ?? [];
  // Questions get at most MAX_QUESTION_ROUNDS rounds; after that the brief stands as it is.
  if (questions.length > 0 && state.questionRounds < MAX_QUESTION_ROUNDS) {
    return {
      ...state,
      phase: "asking",
      refine: output,
      questions: [...questions],
      questionRounds: state.questionRounds + 1,
    };
  }
  return {
    ...state,
    phase: state.mode === "confirm" ? "confirming" : "dispatching",
    refine: output,
    questions: [],
    brief: { title: output.title, text: output.brief },
  };
}

function withItems(state: OrchestrationState, items: OrchestrationItem[]): OrchestrationState {
  const next = { ...state, items: copyItems(items) };
  const progress = itemsProgress(items);
  if (progress === "settled") return { ...next, phase: "synthesizing" };
  if (progress === "stalled") return { ...next, phase: "stalled" };
  return { ...next, phase: "awaiting" };
}

function copyItems(items: readonly OrchestrationItem[]): OrchestrationItem[] {
  return items.map((item) => ({ ...item }));
}
