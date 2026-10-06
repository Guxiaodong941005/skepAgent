import type { LogEntry } from "../log.js";
import type { SkepEvent } from "../schemas/events.js";
import { applyEvent } from "./apply.js";
import { authorize } from "./authz.js";
import { GenesisError, genesisState } from "./genesis.js";
import type { LogOutcome, State } from "./state.js";
import { checkStructure } from "./structural.js";

export function applyEntry(state: State, entry: LogEntry): State {
  if (entry.seq !== state.seq + 1) {
    throw new RangeError(
      `Expected log seq ${state.seq + 1} after ${state.tip}, received ${entry.seq}`,
    );
  }
  const next = structuredClone(state);
  const outcome: LogOutcome = {
    seq: entry.seq,
    sha: entry.sha,
    outcome: "invalid",
    reason: null,
    event_id: null,
    type: null,
    task_id: null,
    actor: null,
    signer: entry.signature.status === "good" ? entry.signature.principal : null,
  };
  const structure = checkStructure(entry, state.tip);
  if (!structure.ok) {
    outcome.reason = structure.reason;
  } else {
    const { event, principal } = structure;
    Object.assign(outcome, {
      event_id: event.event_id,
      type: event.type,
      task_id: event.task_id,
      actor: event.actor,
    } satisfies Partial<LogOutcome>);
    if (Object.hasOwn(state.seen_event_ids, event.event_id)) {
      outcome.outcome = "duplicate";
    } else if (event.observed_tip !== entry.parents[0]) {
      outcome.outcome = "rejected";
      outcome.reason = "stale_tip";
    } else if (!authorize(principal, event, state)) {
      outcome.outcome = "rejected";
      outcome.reason = "unauthorized";
    } else {
      // ARCHITECTURE §5.3: a handler's rejected draft is discarded in full, but its ID is seen.
      const draft = structuredClone(state);
      const result = applyEvent(draft, event, { seq: entry.seq, sha: entry.sha, principal });
      outcome.outcome = result.ok ? "accepted" : "rejected";
      outcome.reason = result.ok ? null : result.reason;
      if (result.ok) {
        advanceTaskRevision(draft, event, entry.seq);
        draft.seen_event_ids[event.event_id] = entry.seq;
        return finish(draft, entry, outcome);
      }
      next.seen_event_ids[event.event_id] = entry.seq;
    }
  }
  return finish(next, entry, outcome);
}

function advanceTaskRevision(state: State, event: SkepEvent, seq: number): void {
  if (event.task_id === null) return;
  const task = state.tasks[event.task_id];
  if (task) {
    task.rev += 1;
    task.last_seq = seq;
  }
}

function finish(state: State, entry: LogEntry, outcome: LogOutcome): State {
  state.tip = entry.sha;
  state.seq = entry.seq;
  state.outcomes.push(outcome);
  return state;
}

export function replay(entries: LogEntry[]): State {
  const first = entries[0];
  if (!first) throw new GenesisError("the log is empty; a human-signed root commit is required");
  return entries.slice(1).reduce(applyEntry, genesisState(first));
}
