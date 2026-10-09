import type { Duplex } from "node:stream";
import type { Clock } from "../util/clock.js";
import type { RandomSource } from "../util/random.js";
import type { DatalistEntry, PlanItem, SessionStatus, SubResult } from "./messages.js";
import type { PeerPath } from "./path.js";

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
}

export interface SubHandle {
  readonly peerId: string;
  readonly sessionId: string;
  readonly fingerprint: string;
  close(): Promise<void>;
  readonly closed: Promise<{ reason: string }>;
}

export { JoinRejectedError, normalizeJoinCode } from "./handshake.js";
export { ListenAddressError, startMaster } from "./master.js";
export { assertSamePath, PathMismatchError } from "./path.js";
export { connectSub } from "./sub.js";
export type { DatalistEntry, PeerPath, PlanItem, SessionStatus, SubResult };
