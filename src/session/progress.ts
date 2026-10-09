/**
 * Peer progress for the session TUI strip (docs/plans/peer-progress-bee.md §2–§3).
 *
 * MVP metric: `percent = floor(100 * done / total)` over the items assigned to a peer, where an
 * item is done once the master accepted its result or it failed (dropped assignee). The master
 * always derives counts from its own item states, so a sub cannot inflate its percentage; only
 * the phase `blocked` and the summary come from the sub's own report.
 */
import { Redactor } from "../exec/redact.js";
import { ChannelError } from "./channel.js";
import type { ItemStatus } from "./messages.js";

export const PEER_PHASES = ["idle", "working", "blocked", "done"] as const;
export type PeerPhase = (typeof PEER_PHASES)[number];
/** "left" exists only on master→sub relays: the subject disconnected; drop its row. */
export type RelayPhase = PeerPhase | "left";

/** What one peer's strip shows. Plain JSON. */
export interface PeerProgress {
  peerId: string;
  device: string;
  role: string | null;
  phase: RelayPhase;
  /** Assigned items finished (done or failed). */
  done: number;
  /** Assigned items. */
  total: number;
  /** Subset of done that failed (dropped assignee or a failing check). */
  failed: number;
  percent: number;
  /** At most 120 chars, "" when idle. */
  summary: string;
  /** The item the summary is about. */
  itemId?: string;
}

/** Progress without the master-filled identity: the sub→master shape and the status shape. */
export type ProgressValue = Omit<PeerProgress, "peerId" | "device" | "role" | "phase"> & {
  phase: PeerPhase;
};

/** What the master keeps from a sub's own report; its counts are informational only. */
export interface ReportedProgress {
  phase: PeerPhase;
  summary: string;
  itemId?: string;
}

export const SUMMARY_MAX = 120;

/** Default 500 ms (plan §2.5); 0 disables coalescing, which tests use. */
export function progressInterval(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isFinite(result) || result < 0)
    throw new ChannelError("Progress interval must be non-negative finite milliseconds");
  return result;
}

export function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((100 * done) / total);
}

/** Authoritative master-side view of one peer (plan §3.2). Pure. */
export function deriveProgress(
  items: readonly ItemStatus[],
  peerId: string,
  reported: ReportedProgress | null,
): ProgressValue {
  const assigned = items.filter((item) => item.assignee === peerId);
  const finished = assigned.filter((item) => item.state === "done" || item.state === "failed");
  const failed = assigned.filter(
    (item) =>
      item.state === "failed" ||
      (item.state === "done" && item.result?.checks.some((check) => check.status === "fail")),
  ).length;
  const claimed = assigned.find((item) => item.state === "claimed");
  const total = assigned.length;
  const done = finished.length;
  // Only the sub can know an agent is waiting for a human, so a reported `blocked` wins even at
  // 100 %: a blocked agent's result is accepted (`submit.state: "pending"`) but a human still
  // owes an answer or a submit.
  const phase: PeerPhase =
    reported?.phase === "blocked"
      ? "blocked"
      : claimed || reported?.phase === "working"
        ? "working"
        : total > 0 && done === total
          ? "done"
          : "idle";
  const reportedItem =
    reported?.itemId === undefined || reported.summary === ""
      ? undefined
      : assigned.find((item) => item.itemId === reported.itemId);
  // Re-redact independently of the sub, as result summaries are (ARCHITECTURE §16).
  const subject = reportedItem
    ? { summary: new Redactor().redact(reported?.summary ?? ""), itemId: reportedItem.itemId }
    : claimed
      ? { summary: claimed.title, itemId: claimed.itemId }
      : null;
  return {
    phase,
    done,
    total,
    failed,
    percent: percentOf(done, total),
    summary: subject ? subject.summary.slice(0, SUMMARY_MAX) : "",
    ...(subject ? { itemId: subject.itemId } : {}),
  };
}

export type SubItemState = "claiming" | "working" | "sent" | "done" | "rejected";
export type SubAgentState = "starting" | "running" | "blocked" | "done" | "failed";

/**
 * What a sub reports about itself (plan §3.1). Pure. `items` must be in claim order. `blocked`
 * is the sticky "an agent of this join was ever blocked" flag: the human finishes a blocked item
 * with `skep session submit` in another process, which this process never sees.
 */
export function subProgress(
  items: Iterable<{ itemId: string; title: string; state: SubItemState }>,
  agents: ReadonlyMap<string, SubAgentState>,
  blocked: boolean,
): ProgressValue {
  const counted = [...items].filter((item) => item.state !== "rejected");
  const finished = counted.filter((item) => item.state === "done");
  // Only finished items count as failed, so `failed ≤ done` holds for the wire schema.
  const failed = finished.filter((item) => agents.get(item.itemId) === "failed").length;
  const active = counted.filter((item) => item.state !== "done").at(-1);
  const agentStates = [...agents.values()];
  const phase: PeerPhase =
    blocked || agentStates.includes("blocked")
      ? "blocked"
      : active || agentStates.some((state) => state === "starting" || state === "running")
        ? "working"
        : counted.length > 0 && finished.length === counted.length
          ? "done"
          : "idle";
  // Only master-sent (already redacted) titles: the sub never reports free text.
  return {
    phase,
    done: finished.length,
    total: counted.length,
    failed,
    percent: percentOf(finished.length, counted.length),
    summary: active ? active.title.slice(0, SUMMARY_MAX) : "",
    ...(active ? { itemId: active.itemId } : {}),
  };
}

type Comparable = ProgressValue | PeerProgress;
const PROGRESS_KEYS = [
  "peerId",
  "device",
  "role",
  "phase",
  "done",
  "total",
  "failed",
  "percent",
  "summary",
  "itemId",
] as const;

export function sameProgress(a: Comparable, b: Comparable): boolean {
  return PROGRESS_KEYS.every(
    (key) => (a as Partial<PeerProgress>)[key] === (b as Partial<PeerProgress>)[key],
  );
}

/**
 * At most one frame per `intervalMs` per subject (plan §2.5). A phase change goes out at once,
 * a value equal to the last one sent is dropped, and changes inside the window collapse into
 * one trailing send of the latest value at `lastSentAt + intervalMs`.
 */
export class ProgressCoalescer<T extends Comparable> {
  private last: T | null = null;
  private lastSentAt = 0;
  private pending: T | null = null;
  private cancelTrailing: (() => void) | null = null;

  constructor(
    private readonly o: {
      intervalMs: number;
      monotonicMs: () => number;
      /** The owner's Clock-backed timer (`SessionMaster.timer` / `SessionWire.timer`). */
      schedule: (ms: number, fn: () => void) => () => void;
      send: (value: T) => void;
    },
  ) {}

  push(value: T): void {
    if (this.last && sameProgress(this.last, value)) {
      // Back to what the peer already has: a pending trailing send would only repeat it.
      this.drop();
      return;
    }
    const wait = this.lastSentAt + this.o.intervalMs - this.o.monotonicMs();
    if (!this.last || this.last.phase !== value.phase || wait <= 0) {
      this.drop();
      this.emit(value);
      return;
    }
    this.pending = value;
    this.cancelTrailing ??= this.o.schedule(wait, () => {
      this.cancelTrailing = null;
      const latest = this.pending;
      this.pending = null;
      if (latest) this.emit(latest);
    });
  }

  cancel(): void {
    this.drop();
  }

  private drop(): void {
    this.pending = null;
    this.cancelTrailing?.();
    this.cancelTrailing = null;
  }

  private emit(value: T): void {
    this.last = value;
    this.lastSentAt = this.o.monotonicMs();
    this.o.send(value);
  }
}
