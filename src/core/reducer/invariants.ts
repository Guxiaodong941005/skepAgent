import { canonicalJson } from "../canonical.js";
import type { LogEntry } from "../log.js";
import type { SkepEvent } from "../schemas/events.js";
import { activeLeaseCount } from "./handlers/lease.js";
import { applyEntry, replay } from "./replay.js";
import type { State } from "./state.js";
import { checkStructure } from "./structural.js";

/**
 * Pure invariant predicates over a replayed log (ARCHITECTURE §13.2, PRD §16.3). Invariants 2–4,
 * 6, 8 and 9 are checkable from `(entries, state)` alone; 1, 5 and 7 need several daemons, the
 * code remote or heartbeat refs and live in the simulator. `skep doctor` and the sim checker
 * share these predicates, so a violation means the same thing in both places.
 *
 * Nothing here re-decides a handler rule. Each predicate reads the outcomes the reducer recorded
 * and the items, epochs and leases those handlers left behind, then checks that the two agree.
 */

export interface Violation {
  /** Invariant number from ARCHITECTURE §13.2. */
  invariant: 2 | 3 | 4 | 6 | 8 | 9;
  /** First-parent seq of the offending entry, when the violation is about one commit. */
  seq: number | null;
  /** Task the violation is about, when it is about one task. */
  task_id: string | null;
  /** Stable machine-readable tag. */
  code: string;
  /** Human-readable explanation naming the conflicting facts. */
  detail: string;
}

export function checkInvariants(entries: readonly LogEntry[], state: State): Violation[] {
  const accepted = acceptedEvents(entries, state);
  // Invariants 4 and 9 both need the state at every seq. Replay the log once and share it;
  // replaying per invariant dominates `skep doctor` and the property tests on long logs.
  const steps = walk(entries);
  return [
    ...checkDeliveryUniqueness(accepted),
    ...checkFencedEpochs(accepted, state),
    ...checkRejectedAreNoOps(steps),
    ...checkBarrierAndAuthorization(steps),
    ...checkBudgets(state),
    ...checkStatusAgreesWithItems(state),
    ...checkMaxParallel(steps),
  ];
}

interface Accepted {
  seq: number;
  event: SkepEvent;
}

/**
 * Recover the events the reducer accepted, in seq order. Domain effects come from `state`; this
 * walk only reparses entries the outcome log already classified, so a handler is never re-run.
 * A seq gap throws: the predicates are only defined for the contiguous log `replay` consumed.
 */
function acceptedEvents(entries: readonly LogEntry[], state: State): Accepted[] {
  const bySeq = new Map<number, LogEntry>();
  for (const entry of entries) bySeq.set(entry.seq, entry);
  const accepted: Accepted[] = [];
  let prevTip = state.genesis_sha;
  for (let seq = 1; seq <= state.seq; seq++) {
    const entry = bySeq.get(seq);
    if (!entry) {
      throw new RangeError(
        `Invariant check expected an entry at seq ${seq}; the log has a gap before tip ${state.tip}`,
      );
    }
    const outcome = state.outcomes[seq - 1];
    if (outcome?.seq !== seq) {
      throw new RangeError(
        `Invariant check expected outcome seq ${seq}, found ${outcome?.seq ?? "none"}`,
      );
    }
    if (outcome.outcome === "accepted") {
      const structure = checkStructure(entry, prevTip);
      if (!structure.ok || structure.event.event_id !== outcome.event_id) {
        throw new RangeError(
          `Outcome at seq ${seq} says ${outcome.event_id} was accepted, but the entry does not parse to that event`,
        );
      }
      accepted.push({ seq, event: structure.event });
    }
    prevTip = entry.sha;
  }
  return accepted;
}

/**
 * Invariant 2, first half: at most one accepted `work.delivered` per (task, item, epoch)
 * (ARCHITECTURE §13.2).
 */
function checkDeliveryUniqueness(accepted: readonly Accepted[]): Violation[] {
  const violations: Violation[] = [];
  const seen = new Map<string, number>();
  for (const { seq, event } of accepted) {
    if (event.type !== "work.delivered") continue;
    const key = `${event.task_id}\u0000${event.payload.item}\u0000${event.payload.epoch}`;
    const first = seen.get(key);
    if (first !== undefined) {
      violations.push({
        invariant: 2,
        seq,
        task_id: event.task_id,
        code: "duplicate_delivery",
        detail: `accepted work.delivered for ${event.task_id} ${event.payload.item} epoch ${event.payload.epoch} at seq ${seq} and seq ${first}`,
      });
    } else {
      seen.set(key, seq);
    }
  }
  return violations;
}

/**
 * Invariant 2, second half: no accepted fenced event names an epoch other than the item's
 * current one. Epochs only rise, and only an accepted `lease.claimed` for that item rises them
 * (PRD §9.5), so the epoch current at seq N is the number of earlier accepted claims of the item.
 */
function checkFencedEpochs(accepted: readonly Accepted[], state: State): Violation[] {
  const violations: Violation[] = [];
  const epochOf = new Map<string, number>();
  for (const { seq, event } of accepted) {
    if (event.task_id === null || !("item" in event.payload)) continue;
    const item = event.payload.item;
    if (typeof item !== "string") continue;
    const key = itemKey(event.task_id, item);
    if (event.type === "lease.claimed") {
      epochOf.set(key, (epochOf.get(key) ?? 0) + 1);
      continue;
    }
    if (!isFenced(event)) continue;
    const current = epochOf.get(key) ?? 0;
    if (event.payload.epoch !== current) {
      violations.push({
        invariant: 2,
        seq,
        task_id: event.task_id,
        code: "non_current_epoch",
        detail: `accepted ${event.type} for ${event.task_id} ${event.payload.item} names epoch ${event.payload.epoch}, but the current epoch at seq ${seq} is ${current}`,
      });
    }
  }
  // The same claim walk is what the reducer stores in `epochs` (PRD §9.5: epochs survive replans).
  for (const task of Object.values(state.tasks)) {
    for (const [item, epoch] of Object.entries(task.epochs)) {
      const counted = epochOf.get(itemKey(task.task_id, item)) ?? 0;
      if (counted !== epoch) {
        violations.push({
          invariant: 2,
          seq: null,
          task_id: task.task_id,
          code: "epoch_disagrees",
          detail: `${task.task_id} ${item} records epoch ${epoch} but ${counted} lease.claimed events were accepted`,
        });
      }
    }
  }
  return violations;
}

type FencedType =
  | "work.delivered"
  | "work.failed"
  | "lease.released"
  | "lease.revoked"
  | "checkpoint.recorded";

function isFenced(
  event: SkepEvent,
): event is SkepEvent & { type: FencedType; payload: { item: string; epoch: number } } {
  return (
    event.type === "work.delivered" ||
    event.type === "work.failed" ||
    event.type === "lease.released" ||
    event.type === "lease.revoked" ||
    event.type === "checkpoint.recorded"
  );
}

function itemKey(taskId: string, item: string): string {
  return `${taskId}\u0000${item}`;
}

/**
 * Invariant 3: a rejected event changes nothing but `outcomes` and `seen_event_ids`, and an
 * accepted event's `observed_tip` equals its parent (ARCHITECTURE §5.3, §13.2). Which rejections
 * consume the event id is the reducer's own rule (`replay.ts`): `stale_tip` and `unauthorized`
 * do not, everything else does.
 */
function checkRejectedAreNoOps(steps: readonly Step[]): Violation[] {
  const violations: Violation[] = [];
  const seen = new Map<string, number>();
  let prevTip: string | null = null;
  for (const { entry, before, after } of steps) {
    prevTip ??= before.tip;
    const outcome = after.outcomes[entry.seq - 1];
    if (!outcome) continue;
    if (
      outcome.outcome === "rejected" ||
      outcome.outcome === "invalid" ||
      outcome.outcome === "duplicate"
    ) {
      // ARCHITECTURE §5.3 / §13.2 invariant 3: a rejection or a structurally invalid commit changes
      // nothing but the audit fields. tip and seq advance for every entry, so they are not domain
      // state; `seen_event_ids` changes only for a semantic rejection (not stale_tip/unauthorized).
      const changed = domainJson(before) !== domainJson(after);
      if (changed) {
        violations.push({
          invariant: 3,
          seq: entry.seq,
          task_id: outcome.task_id,
          code: "rejected_changed_state",
          detail: `${outcome.outcome} event at seq ${entry.seq} (${outcome.reason ?? "no reason"}) changed state other than outcomes and seen_event_ids`,
        });
      }
    }
    if (outcome.outcome === "rejected") {
      if (outcome.event_id === null || outcome.reason === null) {
        violations.push({
          invariant: 3,
          seq: outcome.seq,
          task_id: outcome.task_id,
          code: "rejected_without_record",
          detail: `seq ${outcome.seq} is rejected but records no event_id or reason`,
        });
      } else {
        const consumedAt = after.seen_event_ids[outcome.event_id];
        const consumesNothing = outcome.reason === "stale_tip" || outcome.reason === "unauthorized";
        if (consumesNothing && consumedAt === outcome.seq) {
          violations.push({
            invariant: 3,
            seq: outcome.seq,
            task_id: outcome.task_id,
            code: "rejected_consumed_id",
            detail: `${outcome.reason} at seq ${outcome.seq} consumed event id ${outcome.event_id}; only outcomes may change`,
          });
        } else if (!consumesNothing && consumedAt === undefined) {
          violations.push({
            invariant: 3,
            seq: outcome.seq,
            task_id: outcome.task_id,
            code: "rejected_not_seen",
            detail: `rejected ${outcome.type ?? "event"} ${outcome.event_id} at seq ${outcome.seq} (${outcome.reason}) is absent from seen_event_ids`,
          });
        }
      }
    }
    if (outcome.event_id !== null && outcome.outcome === "accepted") {
      const prior = seen.get(outcome.event_id);
      if (prior !== undefined) {
        violations.push({
          invariant: 3,
          seq: outcome.seq,
          task_id: outcome.task_id,
          code: "accepted_twice",
          detail: `event ${outcome.event_id} was accepted at seq ${prior} and again at seq ${outcome.seq}`,
        });
      }
      seen.set(outcome.event_id, outcome.seq);
    }
    if (outcome.outcome === "accepted" || outcome.outcome === "rejected") {
      const structure = checkStructure(entry, prevTip);
      if (
        structure.ok &&
        structure.event.observed_tip !== entry.parents[0] &&
        outcome.reason !== "stale_tip"
      ) {
        violations.push({
          invariant: 3,
          seq: outcome.seq,
          task_id: outcome.task_id,
          code: "observed_tip_mismatch",
          detail: `seq ${outcome.seq} has observed_tip ${structure.event.observed_tip} ≠ parent ${entry.parents[0]} but was ${outcome.outcome} as ${outcome.reason ?? "accepted"}`,
        });
      }
    }
    prevTip = entry.sha;
  }
  return violations;
}

/**
 * Domain state for the invariant-3 no-op check. `tip`/`seq` advance on every entry and
 * `outcomes` records it; `seen_event_ids` is the one domain field a semantic rejection may touch
 * (PRD §8.2 rule 5). Everything else must be byte-identical.
 */
function domainJson(state: State): string {
  const { outcomes: _outcomes, seen_event_ids: _seen, tip: _tip, seq: _seq, ...domain } = state;
  return canonicalJson(domain);
}

/**
 * Invariant 4 (ARCHITECTURE §13.2): no `lease.claimed` is accepted while that task's barrier is
 * open, and no commit with a bad signature is accepted. Both facts are read from the reducer's
 * own state at that seq — `task.barrier` with `closed_seq === null` is the handler's definition
 * of "open" (`barrier_open` in `lease.ts`) — so this never re-derives when a barrier opens.
 */
function checkBarrierAndAuthorization(steps: readonly Step[]): Violation[] {
  const violations: Violation[] = [];
  for (const point of steps) {
    const { entry, before, after } = point;
    const outcome = after.outcomes[entry.seq - 1];
    if (outcome?.outcome !== "accepted") continue;
    if (entry.signature.status !== "good") {
      violations.push({
        invariant: 4,
        seq: entry.seq,
        task_id: outcome.task_id,
        code: "accepted_unauthorized",
        detail: `seq ${entry.seq} was accepted with signature status ${entry.signature.status}`,
      });
    }
    if (outcome.type !== "lease.claimed" || outcome.task_id === null) continue;
    const barrier = before.tasks[outcome.task_id]?.barrier;
    if (barrier && barrier.closed_seq === null) {
      violations.push({
        invariant: 4,
        seq: entry.seq,
        task_id: outcome.task_id,
        code: "claim_during_barrier",
        detail: `lease.claimed accepted at seq ${entry.seq} while barrier ${barrier.id} is open on ${outcome.task_id}`,
      });
    }
  }
  return violations;
}

/**
 * Invariant 6: `replan_count` and `review_rounds` stay within budget unless the task is
 * escalated. `replan_count` is a lifetime counter and is not reset when the human resumes
 * (ARCHITECTURE §5.5, D12), so once a `human.decided` has put the task back to work the count may
 * legally exceed the budget; the next replan escalates again.
 */
function checkBudgets(state: State): Violation[] {
  const violations: Violation[] = [];
  const resumed = resumedTasks(state);
  for (const task of Object.values(state.tasks)) {
    // Escalation is how an over-budget task stops, and a terminal task is no longer spending.
    if (task.status === "escalated" || task.status === "cancelled" || task.status === "done")
      continue;
    // An over-budget replan still waits for leased items to checkpoint before it escalates
    // (ARCHITECTURE §5.5: "exhausted replans still wait for holders to settle"), so `interrupting`
    // with the over-budget barrier open is the rule, not a violation of it.
    const settling = task.status === "interrupting" && task.barrier?.escalate === true;
    if (task.replan_count > task.budgets.replans && !resumed.has(task.task_id) && !settling) {
      violations.push({
        invariant: 6,
        seq: null,
        task_id: task.task_id,
        code: "replan_budget",
        detail: `${task.task_id} has replan_count ${task.replan_count} over budget ${task.budgets.replans} while ${task.status}`,
      });
    }
    if (task.review_rounds > task.budgets.review_rounds) {
      violations.push({
        invariant: 6,
        seq: null,
        task_id: task.task_id,
        code: "review_budget",
        detail: `${task.task_id} has review_rounds ${task.review_rounds} over budget ${task.budgets.review_rounds} while ${task.status}`,
      });
    }
  }
  return violations;
}

/** Tasks a `human.decided` has moved out of escalation, where the lifetime replan count no longer binds. */
function resumedTasks(state: State): Set<string> {
  const resumed = new Set<string>();
  for (const outcome of state.outcomes) {
    if (
      outcome.outcome === "accepted" &&
      outcome.type === "human.decided" &&
      outcome.task_id !== null
    ) {
      resumed.add(outcome.task_id);
    }
  }
  return resumed;
}

/**
 * Invariant 8 (D14/D15): task status agrees with its items. `executing` still has work that is
 * neither delivered nor merged; `delivered` means every item is delivered or merged and at least
 * one is not merged; an escalation for `verification_failed` records `verified.passed == false`.
 */
function checkStatusAgreesWithItems(state: State): Violation[] {
  const violations: Violation[] = [];
  for (const task of Object.values(state.tasks)) {
    const items = Object.values(task.items);
    const deliveredOrMerged = (status: string): boolean =>
      status === "delivered" || status === "merged";
    if (task.status === "executing") {
      const workLeft = items.some((item) => !deliveredOrMerged(item.status));
      if (items.length === 0 || !workLeft) {
        violations.push({
          invariant: 8,
          seq: task.last_seq,
          task_id: task.task_id,
          code: "executing_without_work",
          detail:
            items.length === 0
              ? `${task.task_id} is executing but has no items`
              : `${task.task_id} is executing but every item is delivered or merged`,
        });
      }
    }
    if (task.status === "delivered") {
      const allSettled = items.length > 0 && items.every((item) => deliveredOrMerged(item.status));
      const allMerged = items.length > 0 && items.every((item) => item.status === "merged");
      if (!allSettled || allMerged) {
        violations.push({
          invariant: 8,
          seq: task.last_seq,
          task_id: task.task_id,
          code: "delivered_disagrees",
          detail: `${task.task_id} is delivered but its items are [${items.map((item) => item.status).join(", ")}]`,
        });
      }
    }
    if (task.escalation?.reason === "verification_failed" && task.verified?.passed !== false) {
      violations.push({
        invariant: 8,
        seq: task.escalation.seq,
        task_id: task.task_id,
        code: "verification_failed_without_record",
        detail: `${task.task_id} is escalated for verification_failed but verified.passed is ${String(task.verified?.passed ?? "unset")}`,
      });
    }
  }
  return violations;
}

/**
 * Invariant 9 (D16, ARCHITECTURE §13.2): right after every accepted `lease.claimed`, the actor's
 * `activeLeaseCount` — items still in status `leased`, parked `interrupted` leases excluded — is
 * within the `max_parallel_items` recorded for that actor at that seq. The count is the handler's
 * own function, read off the reducer's state; it is not recomputed here.
 */
function checkMaxParallel(steps: readonly Step[]): Violation[] {
  const violations: Violation[] = [];
  for (const { entry, after } of steps) {
    const outcome = after.outcomes[entry.seq - 1];
    if (outcome?.outcome !== "accepted" || outcome.type !== "lease.claimed") continue;
    if (outcome.actor === null) continue;
    const agent = after.agents[outcome.actor];
    if (!agent) continue;
    const held = activeLeaseCount(after, outcome.actor);
    if (held > agent.profile.max_parallel_items) {
      violations.push({
        invariant: 9,
        seq: entry.seq,
        task_id: outcome.task_id,
        code: "max_parallel",
        detail: `${outcome.actor} held ${held} active leases after the claim at seq ${entry.seq}, over max_parallel_items ${agent.profile.max_parallel_items}`,
      });
    }
  }
  return violations;
}

interface Step {
  entry: LogEntry;
  /** Reducer state the entry was decided against. */
  before: State;
  /** Reducer state after the entry, including its outcome. */
  after: State;
}

/**
 * One incremental replay shared by the invariants that need state at a seq (4 and 9). Reading the
 * reducer's own `barrier` and `activeLeaseCount` is the point: re-deriving those here would be a
 * second copy of the handler rules (ARCHITECTURE §13.2, "never reimplement handler rules").
 */
function walk(entries: readonly LogEntry[]): Step[] {
  const ordered = entries.slice().sort((a, b) => a.seq - b.seq);
  const genesis = ordered[0];
  if (genesis?.seq !== 0) {
    throw new RangeError("Invariant check requires the genesis entry at seq 0");
  }
  const steps: Step[] = [];
  let before = replay([genesis]);
  for (const entry of ordered) {
    if (entry.seq === 0) continue;
    const after = applyEntry(before, entry);
    steps.push({ entry, before, after });
    before = after;
  }
  return steps;
}
