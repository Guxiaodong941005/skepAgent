import type { Duplex } from "node:stream";
import type { Clock } from "../util/clock.js";
import type { RandomSource } from "../util/random.js";
import type {
  Changed,
  ChangedFile,
  DatalistEntry,
  PlanItem,
  ProtocolVersion,
  SessionStatus,
  SubmitMethod,
  SubmitOutcome,
  SubmitState,
  SubResult,
} from "./messages.js";
import type { PeerPath } from "./path.js";
import type { PeerPhase, PeerProgress } from "./progress.js";

/** Agent lifecycle states a join reports for its own items (`SubHandle.reportAgent`). */
export type AgentProgressState = "starting" | "running" | "blocked" | "done" | "failed";

export interface MasterOptions {
  listen?: { host: string; port: number };
  device: string;
  repo: string;
  controlToken: string;
  acceptJoin(req: {
    device: string;
    fingerprint: string;
    address: string;
    family: "IPv4" | "IPv6";
  }): Promise<boolean>;
  onJoinCode(info: { code: string; expiresAtMs: number }): void;
  /**
   * `message` is the operator line (a successful result capped for plain scrollback); `full`,
   * when present, is the same block uncapped for screens that scroll (SCROLL-2, S2).
   */
  onEvent?(e: MasterEvent): void;
  /** This device's Skep release, sent to v2 peers in `welcome` (ORCH-6). */
  version?: string;
  clock?: Clock;
  random?: RandomSource;
  heartbeatMs?: number;
  joinCodeTtlMs?: number;
  datalistTimeoutMs?: number;
  /** Peer progress coalescing window per subject (default 500 ms; 0 disables coalescing). */
  progressIntervalMs?: number;
}

/**
 * One master event. `peerId` names the peer an event is about when the master knows it (v2
 * `share-output` and `peer-output`); `itemId` the item a `peer-output` belongs to.
 */
export interface MasterEvent {
  kind: string;
  message: string;
  full?: string;
  peerId?: string;
  itemId?: string;
}

export interface MasterHandle {
  readonly address: { host: string; port: number } | null;
  readonly sessionId: string;
  status(): SessionStatus;
  submitIntent(text: string, repos?: string[]): Promise<{ intentId: string }>;
  /**
   * Milliseconds since each connected peer was last heard from (heartbeats included). Optional
   * only so hand-written test doubles still type; `startMaster` always provides it.
   */
  presence?(): { peerId: string; silentMs: number }[];
  attach(stream: Duplex, path: PeerPath): void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

export interface ItemContext {
  intentText?: string;
}

export interface SubOptions {
  stream?: Duplex;
  target?: { host: string; port: number };
  code: string;
  device: string;
  describe(): Promise<{ repo: string; head: string; role: string }>;
  collectDatalist(repo: string): Promise<DatalistEntry[]>;
  /**
   * `intentText` is the full text of the item's intent from the `intent` frame (≤4000), when it
   * was received; the plan item's `title` is only its first 200 characters (S8).
   */
  onItem(item: PlanItem, context?: ItemContext): Promise<SubResult | null>;
  onFingerprint?(fp: string): void;
  onEvent?(e: { kind: string; message: string }): void;
  /** Session protocol to offer (default 2). A v1 master makes a TCP join retry once with 1. */
  protocol?: ProtocolVersion;
  /** This device's Skep release, reported to a v2 master in `peer-info`. */
  version?: string;
  /**
   * Start with live output shared (v2 only, default false). The choice belongs to this join and
   * is never stored on the device (locked plan §9.9).
   */
  shareOutput?: boolean;
  clock?: Clock;
  random?: RandomSource;
  heartbeatMs?: number;
  /**
   * Own (`self: true`, uncoalesced) and relayed (`self: false`) peer progress. It may fire
   * before `connectSub` resolves. A relay with `phase: "left"` means: drop that peer's row.
   */
  onProgress?(p: PeerProgress & { self: boolean }): void;
  /** Opt in to peer progress (default true). `false` behaves like a ≤ 0.1.2 sub. */
  progress?: boolean;
  /** Own progress coalescing window (default 500 ms; 0 disables coalescing). */
  progressIntervalMs?: number;
}

export interface SubHandle {
  readonly peerId: string;
  readonly sessionId: string;
  readonly fingerprint: string;
  close(): Promise<void>;
  readonly closed: Promise<{ reason: string }>;
  /**
   * Feed an assigned item's agent state into this peer's progress. A no-op after close; an
   * unknown item throws `ChannelError`. Optional only so hand-written test doubles still type;
   * `connectSub` always provides it.
   */
  reportAgent?(itemId: string, state: AgentProgressState): void;
  /** Milliseconds since the master was last heard from. Optional like `reportAgent`. */
  silenceMs?(): number;
  /** The negotiated session protocol. Optional like `reportAgent`. */
  readonly protocol?: ProtocolVersion;
  /** The master's Skep release from a v2 welcome; null on v1. */
  masterVersion?(): string | null;
  sharingOutput?(): boolean;
  /**
   * Turn live output on or off for the rest of this session. Throws `OlderMasterError` on a v1
   * session; the master has no way to receive it.
   */
  shareOutput?(on: boolean): void;
  /**
   * Raw output of a running item's agent. Sent only while sharing is on, as complete lines,
   * control-stripped, redacted and bounded (plan §9.10); otherwise dropped here.
   */
  reportOutput?(itemId: string, chunk: string): void;
}

export { JoinRejectedError, normalizeJoinCode } from "./handshake.js";
export { ListenAddressError, startMaster } from "./master.js";
export { ChangedSchema, SubmitOutcomeSchema } from "./messages.js";
export { assertSamePath, PathMismatchError } from "./path.js";
export { connectSub, OLDER_MASTER_NOTE, OlderMasterError } from "./sub.js";
export type {
  Changed,
  ChangedFile,
  DatalistEntry,
  PeerPath,
  PeerPhase,
  PeerProgress,
  PlanItem,
  ProtocolVersion,
  SessionStatus,
  SubmitMethod,
  SubmitOutcome,
  SubmitState,
  SubResult,
};
