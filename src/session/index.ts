import type { Duplex } from "node:stream";
import type { Clock } from "../util/clock.js";
import type { RandomSource } from "../util/random.js";
import type {
  DatalistEntry,
  PlanItem,
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
  onEvent?(e: { kind: string; message: string }): void;
  clock?: Clock;
  random?: RandomSource;
  heartbeatMs?: number;
  joinCodeTtlMs?: number;
  datalistTimeoutMs?: number;
  /** Peer progress coalescing window per subject (default 500 ms; 0 disables coalescing). */
  progressIntervalMs?: number;
}

export interface MasterHandle {
  readonly address: { host: string; port: number } | null;
  readonly sessionId: string;
  status(): SessionStatus;
  submitIntent(text: string, repos?: string[]): Promise<{ intentId: string }>;
  attach(stream: Duplex, path: PeerPath): void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

export interface SubOptions {
  stream?: Duplex;
  target?: { host: string; port: number };
  code: string;
  device: string;
  describe(): Promise<{ repo: string; head: string; role: string }>;
  collectDatalist(repo: string): Promise<DatalistEntry[]>;
  onItem(item: PlanItem): Promise<SubResult | null>;
  onFingerprint?(fp: string): void;
  onEvent?(e: { kind: string; message: string }): void;
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
}

export { JoinRejectedError, normalizeJoinCode } from "./handshake.js";
export { ListenAddressError, startMaster } from "./master.js";
export { SubmitOutcomeSchema } from "./messages.js";
export { assertSamePath, PathMismatchError } from "./path.js";
export { connectSub } from "./sub.js";
export type {
  DatalistEntry,
  PeerPath,
  PeerPhase,
  PeerProgress,
  PlanItem,
  SessionStatus,
  SubmitMethod,
  SubmitOutcome,
  SubmitState,
  SubResult,
};
