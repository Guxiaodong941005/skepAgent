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
 *
 * A refine with `targets` splits the work into groups, one intent per target repo (plan §7
 * Phase 3, ORCH-7); without targets there is one group the shell's route and picker place. The
 * orchestration waits on every intent that was sent and synthesizes across all groups, those
 * that could not be sent included.
 */

import type { RoleBinding } from "../skills/compose.js";
import type { SkillIdentity } from "../skills/schemas.js";
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
  /** The peer the item is assigned to (its panel id), when the status names it. */
  peerId?: string;
  /** The received summary (≤4000, redacted on master and peer); absent until a result. */
  summary?: string;
  changed?: {
    files: { path: string; change: string; added: number | null; removed: number | null }[];
    total: number;
    partial: boolean;
  };
}

/** One intent of an orchestration: a target repo with its own brief, or the single brief. */
export interface StageProgress {
  id: string;
  status: "pending" | "active" | "settled";
}

export interface OrchestrationGroup {
  stage?: string;
  roles?: string[];
  /** The target repo; null for the single brief the route (and picker) places. */
  repo: string | null;
  /** Overrides of the top-level title and brief; null uses the top-level one. */
  title: string | null;
  brief: string | null;
  /** Set once the intent was sent. */
  intentId: string | null;
  /** Why this group's intent was not sent. */
  error: string | null;
}

export interface OrchestrationState {
  id: string;
  skill?: SkillIdentity;
  contract?: string;
  bindings?: RoleBinding[];
  stages?: StageProgress[];
  skippedRoles?: string[];
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
  /** Set with the brief; one per intent to send. */
  groups: OrchestrationGroup[];
  /** The intents that were sent, in group order. */
  intentIds: string[];
  items: OrchestrationItem[];
  synthesis: string | null;
  /** Synthesis failed: the results are shown as received instead. */
  raw: boolean;
  failure: { stage: "refine" | "dispatch" | "synthesize"; cause: string } | null;
}

export type OrchestrationEvent =
  | { type: "refined"; output: RefineOutput; plan?: SkillPlan }
  | { type: "refineFailed"; cause: string }
  | { type: "answered"; text: string }
  | {
      type: "confirmed";
      brief?: { title: string; text: string };
      groups?: OrchestrationGroup[];
      refine?: RefineOutput;
    }
  | { type: "cancelled" }
  /** One outcome per group, in group order. */
  | {
      type: "dispatched";
      outcomes: DispatchOutcome[];
      bindings?: RoleBinding[];
      skippedRoles?: string[];
    }
  | { type: "dispatchFailed"; cause: string }
  | { type: "itemsChanged"; items: OrchestrationItem[] }
  | { type: "summarizeNow"; items?: OrchestrationItem[] }
  | { type: "synthesized"; text: string }
  | { type: "synthFailed"; cause: string };

export interface SkillPlan {
  groups: OrchestrationGroup[];
  stages: StageProgress[];
  bindings: RoleBinding[];
  skippedRoles: string[];
}

export type DispatchOutcome = ({ intentId: string } | { error: string }) & {
  brief?: string;
  title?: string;
  roles?: string[];
};

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
    groups: [],
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
        groups: event.groups ?? state.groups,
        refine: event.refine ?? state.refine,
      };
    case "dispatching":
      if (event.type === "dispatched")
        return dispatched(
          {
            ...state,
            ...(event.bindings ? { bindings: event.bindings } : {}),
            ...(event.skippedRoles ? { skippedRoles: event.skippedRoles } : {}),
          },
          event.outcomes,
        );
      if (event.type === "dispatchFailed") {
        return { ...state, phase: "failed", failure: { stage: "dispatch", cause: event.cause } };
      }
      return state;
    case "awaiting":
    case "stalled":
      if (event.type === "summarizeNow") {
        const items = event.items ?? state.items;
        return items.length === 0
          ? state
          : {
              ...state,
              items: copyItems(items),
              phase: "synthesizing",
              groups: state.groups.map((g) =>
                g.intentId === null && g.error === null
                  ? { ...g, error: "not sent: summarized before this stage" }
                  : g,
              ),
            };
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
    ...(event.plan === undefined
      ? {}
      : {
          bindings: event.plan.bindings,
          stages: event.plan.stages,
          skippedRoles: event.plan.skippedRoles,
          ...(output.contract === undefined ? {} : { contract: output.contract }),
        }),
    groups:
      event.plan?.groups ??
      (output.targets === undefined || output.targets.length === 0
        ? [{ repo: null, title: null, brief: null, intentId: null, error: null }]
        : output.targets.map((target) => ({
            repo: target.repo ?? null,
            title: target.title ?? null,
            brief: target.brief ?? null,
            intentId: null,
            error: null,
          }))),
  };
}

function dispatched(state: OrchestrationState, outcomes: DispatchOutcome[]): OrchestrationState {
  const sending = dispatchGroups(state);
  const groups = state.groups.map((group) => {
    const index = sending.indexOf(group);
    if (index < 0) return group;
    const outcome = outcomes[index] ?? { error: "not sent" };
    const sent = {
      ...group,
      ...(outcome.brief === undefined ? {} : { brief: outcome.brief }),
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      ...(outcome.roles === undefined ? {} : { roles: [...outcome.roles] }),
    };
    return "intentId" in outcome
      ? { ...sent, intentId: outcome.intentId, error: null }
      : { ...sent, intentId: null, error: outcome.error };
  });
  const intentIds = groups.flatMap((group) => (group.intentId === null ? [] : [group.intentId]));
  if (
    state.stages &&
    state.stages.length > 0 &&
    !sending.some((g) => groups[state.groups.indexOf(g)]?.intentId)
  ) {
    return advanceStage({ ...state, groups, intentIds });
  }
  if (intentIds.length === 0) {
    // Nothing reached a peer: the request failed as a whole, with every group's cause.
    const cause = groups
      .map((group) => (group.repo === null ? group.error : `${group.repo}: ${group.error}`))
      .join("; ");
    return { ...state, groups, phase: "failed", failure: { stage: "dispatch", cause } };
  }
  return { ...state, groups, intentIds, phase: "awaiting" };
}

/** The title and brief a group's intent carries. */
export function groupBrief(
  state: Pick<OrchestrationState, "brief">,
  group: OrchestrationGroup,
): { title: string; text: string } {
  return {
    title: group.title ?? state.brief?.title ?? "",
    text: group.brief ?? state.brief?.text ?? "",
  };
}

const VERDICT_WORDS: Record<ItemVerdict, string> = {
  done: "done",
  failed: "failed",
  "submit-failed": "submit failed",
  pending: "waiting for a human",
  declined: "declined",
  running: "still running",
};
const VERDICT_ORDER: readonly ItemVerdict[] = [
  "done",
  "failed",
  "submit-failed",
  "declined",
  "pending",
  "running",
];

/**
 * Skep's own tally of an orchestration, naming every outcome: `2 of 4 items done: I-4 web on
 * dev-b, …; 1 failed: …; not sent: docs (cause)`. It is shown with the summary whatever the
 * master agent wrote, so a partial failure is never left to the agent's wording (ORCH-7).
 */
export function describeOutcome(state: OrchestrationState): string {
  const parts: string[] = [];
  const total = state.items.length;
  for (const verdict of VERDICT_ORDER) {
    const items = state.items.filter((item) => item.verdict === verdict);
    if (items.length === 0) continue;
    const named = items
      .map((item) => `${item.itemId} ${item.repo} on ${item.device ?? item.peerId ?? "?"}`)
      .join(", ");
    // "2 of 3 done" makes a partial success plain; the other verdicts are counted as they are.
    const count =
      verdict === "done" && items.length < total ? `${items.length} of ${total}` : items.length;
    parts.push(`${count} ${VERDICT_WORDS[verdict]}: ${named}`);
  }
  const unsent = state.groups.filter((group) => group.error !== null);
  if (unsent.length > 0) {
    parts.push(
      `not sent: ${unsent.map((group) => `${group.repo ?? "brief"} (${group.error})`).join(", ")}`,
    );
  }
  const waiting = state.groups.filter(
    (group) =>
      group.intentId !== null && !state.items.some((item) => item.intentId === group.intentId),
  );
  if (waiting.length > 0) {
    parts.push(
      `no item yet: ${waiting.map((group) => `${group.repo ?? "brief"} (intent ${group.intentId})`).join(", ")}`,
    );
  }
  return parts.length === 0 ? "no results" : parts.join("; ");
}

function withItems(state: OrchestrationState, items: OrchestrationItem[]): OrchestrationState {
  const next = { ...state, items: copyItems(items) };
  const current = dispatchGroups(state);
  const currentIds = current.flatMap((g) => (g.intentId ? [g.intentId] : []));
  const relevant = items.filter((item) => currentIds.includes(item.intentId));
  const missing = currentIds.some((id) => !relevant.some((item) => item.intentId === id));
  const progress = missing ? "running" : itemsProgress(relevant);
  if (progress === "settled") return advanceStage(next);
  if (progress === "stalled") return { ...next, phase: "stalled" };
  return { ...next, phase: "awaiting" };
}

/** D36: only the active stage dispatches; no stages preserves the single-wave path. */
export function dispatchGroups(state: OrchestrationState): OrchestrationGroup[] {
  const active = state.stages?.find((s) => s.status === "active");
  return active ? state.groups.filter((g) => g.stage === active.id) : state.groups;
}

function advanceStage(state: OrchestrationState): OrchestrationState {
  if (!state.stages?.length) return { ...state, phase: "synthesizing" };
  const stages = state.stages.map((s) =>
    s.status === "active" ? { ...s, status: "settled" as const } : { ...s },
  );
  for (const stage of stages) {
    if (stage.status !== "pending") continue;
    if (!state.groups.some((g) => g.stage === stage.id)) {
      stage.status = "settled";
      continue;
    }
    stage.status = "active";
    return { ...state, stages, phase: "dispatching" };
  }
  return { ...state, stages, phase: "synthesizing" };
}

function copyItems(items: readonly OrchestrationItem[]): OrchestrationItem[] {
  return items.map((item) => ({
    ...item,
    ...(item.changed
      ? { changed: { ...item.changed, files: item.changed.files.map((file) => ({ ...file })) } }
      : {}),
  }));
}
