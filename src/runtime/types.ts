/**
 * Runtime backend: how a subprocess (agent CLI or trusted check) is started and supervised.
 * MVP: native (`spawn(..., { detached: true })` ⇒ own process group). V1: herdr.
 * See docs/ARCHITECTURE.md §10.
 */

import type { z } from "zod";
import type { AgentCliSchema } from "../core/schemas/common.js";

export interface SpawnOptions {
  argv: [string, ...string[]];
  cwd: string;
  /** Complete environment (already sanitized: no GIT_*, SSH_AUTH_SOCK, GH_TOKEN, ...). */
  env: Record<string, string>;
  /** File that receives combined stdout/stderr. */
  logPath: string;
  /** Optional stdin payload (prompt). */
  stdin?: string;
  /** Run as this OS user (agent user isolation, PRD §11.4); undefined = current user. */
  uid?: number;
  gid?: number;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

export interface ProcessHandle {
  pid: number;
  /** Process group id (== pid for detached spawns). */
  pgid: number;
  /** Process start time as reported by the OS, used to guard against PID reuse (PRD §10.6). */
  startToken: string;
  wait(): Promise<ProcessExit>;
  /** Signal the whole process group. */
  signalGroup(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

export interface RuntimeBackend {
  readonly name: "native" | "herdr";
  spawn(opts: SpawnOptions): Promise<ProcessHandle>;
  /** True if a process group with this pgid and startToken still exists. */
  isAlive(pgid: number, startToken: string): Promise<boolean>;
}

export type AgentViewState = "working" | "idle" | "done" | "blocked" | "unknown";

export interface AgentSessionStart {
  name: string;
  kind: z.infer<typeof AgentCliSchema>;
  cwd: string;
  /** Already sanitized; never provider credentials (ARCHITECTURE D19, D27). */
  env: Record<string, string>;
  args?: string[];
}

export interface AgentSessionHandle {
  name: string;
  paneId: string;
  focusCommand: readonly [string, ...string[]];
}

export interface AgentSessionBackend {
  readonly name: "herdr";
  probe(): Promise<{ protocol: number; schemaVersion: number }>;
  start(opts: AgentSessionStart): Promise<AgentSessionHandle>;
  prompt(h: AgentSessionHandle, text: string): Promise<void>;
  /** Resolves on idle | done | blocked; a timeout rejects with HerdrCallError("timeout"). */
  wait(
    h: AgentSessionHandle,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AgentViewState>;
  /** Plain text: the caller must redact before anything leaves the device (D19). */
  read(h: AgentSessionHandle, opts?: { lines?: number }): Promise<string>;
  focus(h: AgentSessionHandle): Promise<void>;
  close(h: AgentSessionHandle): Promise<void>;
}
