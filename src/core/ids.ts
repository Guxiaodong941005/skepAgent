/**
 * Identifier formats used across the protocol. Pure; no I/O.
 *
 * All IDs are opaque strings on the wire. The regexes here are the single source of truth and are
 * reused by the Zod schemas in `core/schemas/common.ts`.
 */

/** `T-<yyyymmdd>-<4 hex>`; readable, carries no ordering meaning (PRD §9.1). */
export const TASK_ID_RE = /^T-\d{8}-[0-9a-f]{4}$/;

/** `evt_<uuid v4>`; generated once per intent and stable across write-loop retries (PRD §10.2). */
export const EVENT_ID_RE = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Device names, e.g. `mac`, `vps`. Must match the daemon key principal `daemon:<device>`. */
export const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Role names, e.g. `coding`. */
export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** `<device>.<role>[.<n>]`, e.g. `mac.coding`, `vps.coding.2` (PRD §7.2). */
export const AGENT_ID_RE =
  /^([a-z0-9][a-z0-9-]{0,31})\.([a-z][a-z0-9-]{0,31})(?:\.([1-9]\d{0,3}))?$/;

/** Work item IDs inside a plan: `W1`, `W2`, ... */
export const ITEM_ID_RE = /^W[1-9]\d{0,2}$/;

/** Attempt IDs chosen by the claiming daemon. */
export const ATTEMPT_ID_RE = /^att_[0-9a-z]{2,40}$/;

/** Barrier IDs are derived by the reducer from the seq of the opening `replan.requested`. */
export const BARRIER_ID_RE = /^B\d+$/;

/** Git object IDs (SHA-1 or SHA-256 repos), lowercase hex. */
export const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `sha256:<64 hex>` content hashes (plan_hash, log digests). */
export const SHA256_TAGGED_RE = /^sha256:[0-9a-f]{64}$/;

/** Plain 64-hex sha256 (file span hashes, log digests). */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type TaskId = string;
export type EventId = string;
export type AgentId = string;
export type DeviceName = string;
export type ItemId = string;
export type AttemptId = string;
export type BarrierId = string;
export type Sha = string;

export interface ParsedAgentId {
  device: DeviceName;
  role: string;
  instance: number | null;
}

export function parseAgentId(id: string): ParsedAgentId | null {
  const m = AGENT_ID_RE.exec(id);
  if (!m) return null;
  const [, device, role, n] = m;
  if (device === undefined || role === undefined) return null;
  return { device, role, instance: n === undefined ? null : Number(n) };
}

/** Device part of an agent ID, or null if the ID is malformed. */
export function deviceOfAgent(id: AgentId): DeviceName | null {
  return parseAgentId(id)?.device ?? null;
}

/** Code-repo branch for a work-item attempt: `skep/<task>/<item>/e<epoch>` (PRD §8.1). */
export function workBranch(taskId: TaskId, item: ItemId, epoch: number): string {
  return `skep/${taskId}/${item}/e${epoch}`;
}

const WORK_BRANCH_RE = /^skep\/(T-\d{8}-[0-9a-f]{4})\/(W[1-9]\d{0,2})\/e([1-9]\d*)$/;

export function parseWorkBranch(
  branch: string,
): { taskId: TaskId; item: ItemId; epoch: number } | null {
  const m = WORK_BRANCH_RE.exec(branch);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { taskId: m[1], item: m[2], epoch: Number(m[3]) };
}

/** Heartbeat ref for an agent (PRD §10.4). */
export function heartbeatRef(agent: AgentId): string {
  return `refs/heads/hb/${agent}`;
}

/** Blackboard path of an event file (PRD §8.2). Cluster-level events live under `_skep`. */
export function eventPath(taskId: TaskId | null, eventId: EventId): string {
  return `events/${taskId ?? "_skep"}/${eventId}.json`;
}

const EVENT_PATH_RE =
  /^events\/(_skep|T-\d{8}-[0-9a-f]{4})\/(evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export function parseEventPath(path: string): { taskId: TaskId | null; eventId: EventId } | null {
  const m = EVENT_PATH_RE.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { taskId: m[1] === "_skep" ? null : m[1], eventId: m[2] };
}

/** Barrier ID derived from the seq of the `replan.requested` that opened it. */
export function barrierIdForSeq(seq: number): BarrierId {
  return `B${seq}`;
}
