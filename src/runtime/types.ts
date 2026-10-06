/**
 * Runtime backend: how a subprocess (agent CLI or trusted check) is started and supervised.
 * MVP: native (`spawn(..., { detached: true })` ⇒ own process group). V1: herdr.
 * See docs/ARCHITECTURE.md §10.
 */

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
