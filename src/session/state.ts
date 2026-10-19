import type { ClaimMsg, ItemStatus, PlanItem, ResultMsg, SessionMsg } from "./messages.js";

export interface SubCandidate {
  peerId: string;
  repo: string;
  joinedOrder: number;
}

export function matchSub(repo: string, peers: readonly SubCandidate[]): SubCandidate | null {
  let match: SubCandidate | null = null;
  for (const peer of peers) {
    if (peer.repo === repo && (!match || peer.joinedOrder < match.joinedOrder)) match = peer;
  }
  return match;
}

export function buildPlan(
  intent: { text: string; repos?: string[]; peerIds?: string[] },
  masterRepo: string,
  peers: readonly SubCandidate[],
  options: {
    epoch?: number;
    firstItemNumber?: number;
    datalistCounts?: Readonly<Record<string, number>>;
  } = {},
): PlanItem[] {
  const items: PlanItem[] = [];
  const targets = intent.peerIds
    ? [...new Set(intent.peerIds)].flatMap((id) => {
        const peer = peers.find(
          (p) => p.peerId === id && (intent.repos === undefined || intent.repos.includes(p.repo)),
        );
        return peer ? [peer] : [];
      })
    : [...new Set(intent.repos ?? [masterRepo])].flatMap((repo) => {
        const peer = matchSub(repo, peers);
        return peer ? [peer] : [];
      });
  for (const assignee of targets) {
    const repo = assignee.repo;
    items.push({
      itemId: `I-${(options.firstItemNumber ?? 1) + items.length}`,
      repo,
      assignee: assignee.peerId,
      epoch: options.epoch ?? 1,
      title: intent.text.slice(0, 200),
      datalistEntries:
        options.datalistCounts?.[assignee.peerId] ?? options.datalistCounts?.[repo] ?? 0,
    });
  }
  return items;
}

type ClaimReply = Extract<SessionMsg, { type: "claim-ack" | "claim-reject" }>;
type ResultReply = Extract<SessionMsg, { type: "result-ack" | "result-reject" }>;

export function applyClaim(
  items: readonly ItemStatus[],
  peerId: string,
  claim: ClaimMsg,
): { items: ItemStatus[]; reply: ClaimReply } {
  const item = items.find((entry) => entry.itemId === claim.itemId);
  const reason = !item
    ? "unknown_item"
    : item.assignee !== peerId
      ? "not_assignee"
      : item.epoch !== claim.epoch
        ? "stale_epoch"
        : item.state !== "planned"
          ? "already_claimed"
          : null;
  if (reason)
    return { items: [...items], reply: { type: "claim-reject", itemId: claim.itemId, reason } };
  return {
    items: items.map((entry) =>
      entry.itemId === claim.itemId ? { ...entry, state: "claimed" } : entry,
    ),
    reply: { type: "claim-ack", itemId: claim.itemId, epoch: claim.epoch },
  };
}

export function applyResult(
  items: readonly ItemStatus[],
  peerId: string,
  result: ResultMsg,
): { items: ItemStatus[]; reply: ResultReply } {
  const item = items.find((entry) => entry.itemId === result.itemId);
  const reason = !item
    ? "unknown_item"
    : item.assignee !== peerId
      ? "not_assignee"
      : item.epoch !== result.epoch
        ? "stale_epoch"
        : item.repo !== result.repo
          ? "repo_mismatch"
          : item.state !== "claimed"
            ? "not_claimed"
            : null;
  if (reason)
    return { items: [...items], reply: { type: "result-reject", itemId: result.itemId, reason } };
  const { type: _type, ...stored } = result;
  return {
    items: items.map((entry) =>
      entry.itemId === result.itemId ? { ...entry, state: "done", result: stored } : entry,
    ),
    reply: { type: "result-ack", itemId: result.itemId },
  };
}
