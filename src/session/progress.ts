/**
 * Peer progress for the session TUI strip (docs/plans/peer-progress-bee.md §2–§3).
 *
 * MVP metric: `percent = floor(100 * done / total)` over the items assigned to a peer, where an
 * item is done once the master accepted its result or it failed (dropped assignee). The master
 * always derives counts from its own item states, so a sub cannot inflate its percentage; only
 * the phase `blocked` and the summary come from the sub's own report.
 */
import { Redactor } from "../exec/redact.js";
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
