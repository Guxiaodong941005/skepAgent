/**
 * Human rendering of `skep status` and `skep log` (PRD §15.1, ARCHITECTURE §5.6, §12, D18, D19).
 *
 * Pure: the daemon (or the local replay fallback) supplies already-derived data, and this module
 * only turns it into text. `--machine` does not come through here; the commands print the same
 * objects with `canonicalJson` (F20), so the human layout and the JSON stay in lockstep.
 *
 * Nothing here names a provider, a credential, a key or a config hash (D19). Agents show only
 * their id, liveness and the runtime their heartbeat announced.
 */

import type { LogOutcome } from "../core/reducer/state.js";
import { REDUCER_VERSION } from "../core/reducer/state.js";
import type { StatusItem, StatusTask, StatusView } from "../core/reducer/views.js";

/** ARCHITECTURE §8.2 defaults. `late` is the unnamed gap between 3 × interval and `staleMs` (F20). */
export const LIVENESS_DEFAULTS = {
  liveFactor: 3,
  staleMs: 5 * 60_000,
  lostMs: 15 * 60_000,
} as const;

/**
 * Display classes. `late` is not a tracker class: the tracker reports `unknown` for a holder
 * whose heartbeat is older than 3 × its interval but younger than `staleMs` (ARCHITECTURE §8.2).
 * The architect decision recorded in the SK-604 brief is to label that gap `late`.
 */
export type LivenessLabel = "live" | "late" | "stale" | "lost" | "unknown";

/** One agent's liveness as the observer sees it (ARCHITECTURE §8.2, §12). */
export interface AgentLiveness {
  agent: string;
  /** Tracker class. `late` is derived here, never stored by the tracker. */
  cls: "live" | "stale" | "lost" | "unknown";
  /** Observer-relative age of the last heartbeat change, monotonic milliseconds. */
  sinceChangeMs: number;
  /** The interval the heartbeat announced: 60 s with a lease, 300 s idle (§8.1). */
  intervalMs?: number;
  bootId?: string;
  /** Heartbeat `state`, display only. */
  state?: string;
  /** Heartbeat runtime (`native` / `herdr`), display only. */
  runtime?: string;
  /** What the heartbeat says it is working on. */
  lease?: { task: string; item: string; epoch: number | null } | null;
}

/** Fetch freshness (ARCHITECTURE §12, §17.3). `checkedAtMonoMs` is `SyncSnapshot.fetchedAtMonoMs`. */
export interface StatusFreshness {
  /** Monotonic time of the last remote observation, including an unchanged `ls-remote` (F20). */
  checkedAtMonoMs: number | null;
  /** Invalid commits the observer has seen. The human line prints this count. */
  invalidCount: number;
  reducerVersion?: number;
}

/** Hint-channel health (D18, §17.3). Hints are optional; git remains the authority. */
export interface HintHealth {
  /** Channel name (`null` when no relay is configured). */
  name: string;
  connected: boolean;
  /** Monotonic time of the last hint, or null when none has arrived. */
  lastMessageMonoMs: number | null;
}

/** Alarms worth surfacing next to the view (duplicate daemon, invalid commits, sync failure). */
export interface StatusAlarm {
  kind: string;
  detail: string;
}

/**
 * Everything `skep status` renders beyond `statusView`: observer-relative liveness, fetch
 * freshness, hint-channel health and alarms (ARCHITECTURE §12).
 */
export interface StatusExtras {
  liveness: AgentLiveness[];
  freshness: StatusFreshness;
  hints: HintHealth;
  alarms: StatusAlarm[];
  /** Observer's monotonic clock, so ages render without this module reading a clock. */
  nowMonoMs: number;
}

/** A lease whose holder looks stale or lost, and the command a human would run to fence it. */
export interface RevokeSuggestion {
  task: string;
  item: string;
  epoch: number;
  holder: string;
  label: LivenessLabel;
  /** `skep lease revoke <task> <item> --epoch N` (PRD §15.2, ARCHITECTURE §6.4). */
  command: string;
}

const LABEL_RANK: Record<LivenessLabel, number> = {
  unknown: 0,
  live: 1,
  late: 2,
  stale: 3,
  lost: 4,
};

/**
 * Map a tracker class onto the status label. `unknown` inside the 3 × interval … `staleMs` gap
 * is `late` (F20); below the live window it stays `unknown` (not yet observed twice).
 */
export function livenessLabel(
  agent: Pick<AgentLiveness, "cls" | "sinceChangeMs" | "intervalMs">,
  cfg: { liveFactor: number; staleMs: number } = LIVENESS_DEFAULTS,
): LivenessLabel {
  if (agent.cls === "unknown" && agent.intervalMs !== undefined) {
    // Strictly after the live window: at exactly 3 × interval the tracker still says live.
    const liveWindow = cfg.liveFactor * agent.intervalMs;
    if (agent.sinceChangeMs > liveWindow && agent.sinceChangeMs < cfg.staleMs) return "late";
  }
  return agent.cls;
}

/** Leases whose holder is `stale` or `lost`: the MVP asks the human to revoke (ARCHITECTURE §6.4). */
export function revokeSuggestions(view: StatusView, extras: StatusExtras): RevokeSuggestion[] {
  const byAgent = new Map(extras.liveness.map((agent) => [agent.agent, agent]));
  const suggestions: RevokeSuggestion[] = [];
  for (const task of view.tasks) {
    for (const item of task.items) {
      if (item.holder === null || item.epoch === null || item.parked) continue;
      const agent = byAgent.get(item.holder);
      if (!agent) continue;
      const label = livenessLabel(agent);
      if (label !== "stale" && label !== "lost") continue;
      suggestions.push({
        task: task.task_id,
        item: item.id,
        epoch: item.epoch,
        holder: item.holder,
        label,
        command: `skep lease revoke ${task.task_id} ${item.id} --epoch ${item.epoch}`,
      });
    }
  }
  suggestions.sort((a, b) =>
    a.task < b.task ? -1 : a.task > b.task ? 1 : a.item < b.item ? -1 : a.item > b.item ? 1 : 0,
  );
  return suggestions;
}

/** Human text for `skep status` (PRD §15.1). */
export function renderStatus(view: StatusView, extras: StatusExtras): string {
  const lines: string[] = [
    headerLine(view, extras),
    "",
    taskTable(view),
    "",
    agentTable(view, extras),
  ];
  const alarms = renderAlarms(extras.alarms);
  if (alarms.length > 0) lines.push("", alarms);
  const suggestions = revokeSuggestions(view, extras);
  if (suggestions.length > 0) lines.push("", renderSuggestions(suggestions));
  return `${lines.join("\n")}\n`;
}

/** One task's outcomes, oldest first, each with its reason (PRD §15.2). */
export function renderLog(task: string, outcomes: readonly LogOutcome[]): string {
  if (outcomes.length === 0) return `log ${task}: no events\n`;
  const lines = outcomes.map((outcome) => {
    const head = `#${outcome.seq}  ${outcome.outcome.padEnd(9)} ${outcome.actor ?? "-"}`;
    const what = outcome.type ?? "commit";
    const reason = outcome.reason === null ? "" : `  ${outcome.reason}`;
    return `${head}  ${what}${reason}`;
  });
  return `${lines.join("\n")}\n`;
}

function headerLine(view: StatusView, extras: StatusExtras): string {
  const version = extras.freshness.reducerVersion ?? REDUCER_VERSION;
  const age = checkedAge(extras);
  const invalid = extras.freshness.invalidCount;
  const invalidLabel = `${invalid} invalid commit${invalid === 1 ? "" : "s"}`;
  const hints = hintLabel(extras);
  return `blackboard main #${view.seq} (${shortSha(view.tip)}) · checked ${age} · reducer v${version} · ${invalidLabel} · hints ${hints}`;
}

/**
 * "checked", not "fetched": the timestamp advances on an unchanged `ls-remote` too (F20,
 * ARCHITECTURE §17.3), so it means "last looked", not "last new commit".
 */
function checkedAge(extras: StatusExtras): string {
  const at = extras.freshness.checkedAtMonoMs;
  if (at === null) return "never";
  return `${formatDuration(Math.max(0, extras.nowMonoMs - at))} ago`;
}

function hintLabel(extras: StatusExtras): string {
  const { hints, nowMonoMs } = extras;
  if (hints.name === "null" || hints.name === "") return "off";
  const state = hints.connected ? "up" : "down";
  if (hints.lastMessageMonoMs === null) return `${hints.name} ${state}, no messages`;
  const age = formatDuration(Math.max(0, nowMonoMs - hints.lastMessageMonoMs));
  return `${hints.name} ${state}, last ${age} ago`;
}

function taskTable(view: StatusView): string {
  const head = ["TASK", "STATE", "MODE", "OWNER", "PLAN", "REPLAN", "ITEMS"];
  const rows = view.tasks.map((task) => [
    task.task_id,
    task.status,
    task.mode,
    task.owner,
    planCell(task),
    `${task.replan_count}/${task.replan_budget}`,
    itemsCell(task),
  ]);
  return renderColumns(head, rows);
}

function planCell(task: StatusTask): string {
  const version = task.active_plan_version ?? task.current_plan_version;
  if (version === null) return "-";
  // "✔" only once a plan is approved or owner-locked; a proposal still in review stays bare.
  return task.active_plan_version === null ? `v${version}` : `v${version}✔`;
}

function itemsCell(task: StatusTask): string {
  if (task.items.length === 0) return "-";
  return task.items.map(itemCell).join("  ");
}

function itemCell(item: StatusItem): string {
  const bits: string[] = [item.status];
  if (item.epoch !== null) bits.push(`e${item.epoch}`);
  if (item.holder !== null) bits.push(item.holder);
  if (item.parked) bits.push("parked");
  return `${item.id} ${bits.join(" ")}`;
}

function agentTable(view: StatusView, extras: StatusExtras): string {
  const head = ["AGENT", "LIVENESS (here)", "STATE", "LEASE", "RUNTIME", "BOOT"];
  const byAgent = new Map(extras.liveness.map((agent) => [agent.agent, agent]));
  const ids = [
    ...new Set([...view.agents.map((agent) => agent.id), ...extras.liveness.map((a) => a.agent)]),
  ].sort();
  const rows = ids.map((id) => {
    const live = byAgent.get(id);
    return [
      id,
      live ? livenessCell(live) : "unknown",
      live?.state ?? "-",
      live ? leaseCell(live) : "-",
      live?.runtime ?? "-",
      live?.bootId ?? "-",
    ];
  });
  return renderColumns(head, rows);
}

function livenessCell(agent: AgentLiveness): string {
  const label = livenessLabel(agent);
  if (agent.sinceChangeMs <= 0 && label === "unknown") return "unknown";
  return `${label} (hb ${formatDuration(agent.sinceChangeMs)})`;
}

function leaseCell(agent: AgentLiveness): string {
  if (!agent.lease) return "-";
  const epoch = agent.lease.epoch === null ? "" : ` e${agent.lease.epoch}`;
  return `${agent.lease.task}/${agent.lease.item}${epoch}`;
}

function renderAlarms(alarms: readonly StatusAlarm[]): string {
  if (alarms.length === 0) return "";
  const lines = [...alarms]
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.detail < b.detail ? -1 : 1))
    .map((alarm) => `! ${alarm.kind}: ${alarm.detail}`);
  return lines.join("\n");
}

function renderSuggestions(suggestions: readonly RevokeSuggestion[]): string {
  const lines = ["revoke suggested (holder is stale or lost):"];
  for (const suggestion of suggestions) {
    lines.push(
      `  ${suggestion.holder} ${suggestion.label} on ${suggestion.task}/${suggestion.item} e${suggestion.epoch} → ${suggestion.command}`,
    );
  }
  return lines.join("\n");
}

/** Pad every column to its widest cell, except the last, which runs to the end of the line. */
function renderColumns(head: string[], rows: string[][]): string {
  const widths = head.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd();
  return [format(head), ...rows.map(format)].join("\n");
}

/** First seven hex digits of a sha, matching the PRD §15.1 example. */
function shortSha(sha: string): string {
  const hex = sha.startsWith("sha256:") ? sha.slice("sha256:".length) : sha;
  return hex.slice(0, 7);
}

/** Compact age: `41s`, `6m`, `2h`, `3d`. Sub-second ages read as `0s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Worst label first, so a lost holder outranks a merely stale one in summaries. */
export function worstLabel(labels: readonly LivenessLabel[]): LivenessLabel {
  return labels.reduce(
    (worst, label) => (LABEL_RANK[label] > LABEL_RANK[worst] ? label : worst),
    "unknown",
  );
}
