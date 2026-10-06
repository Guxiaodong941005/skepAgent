import type { Usage } from "../core/schemas/work-report.js";

/**
 * Agent adapter contract (PRD §13.1). An adapter turns "prompt + JSON schema + worktree" into one
 * bounded, non-interactive invocation of a pinned agent CLI and returns the raw final message.
 * Validation, the single repair attempt, evidence verification and everything protocol-related
 * stay in the daemon (`src/adapter/structured.ts`), never in the adapter.
 */

export type InvocationKind = "plan" | "review" | "work" | "fixup" | "repair";

export interface AdapterInvocation {
  kind: InvocationKind;
  /** Working directory: the item worktree (work/fixup) or a read-only checkout (plan/review). */
  cwd: string;
  /** Full English prompt (role AGENT.md body + task context + instructions). */
  prompt: string;
  /** JSON Schema the final message must satisfy (generated from Zod via z.toJSONSchema). */
  outputSchema: Record<string, unknown>;
  /** Hard wall-time limit enforced by the daemon (AGENT.md max_invocation_minutes). */
  timeoutMs: number;
  /** Sanitized environment (no git/GH credentials, no SSH agent socket). */
  env: Record<string, string>;
  /** Combined stdout/stderr capture for the run journal. */
  logPath: string;
  /** Scratch directory owned by the daemon (schema files, last-message files). */
  scratchDir: string;
  /** Aborting requests an interrupt; the adapter runs the interrupt ladder (PRD §9.7). */
  signal: AbortSignal;
}

export type InvocationOutcome =
  /** Process exited on its own. */
  | "completed"
  /** Stopped by SIGINT/cooperative stop after an abort. */
  | "interrupted"
  /** Needed SIGTERM/SIGKILL. */
  | "killed"
  /** Hit `timeoutMs` (then laddered down). */
  | "timeout"
  /** CLI asked for interactive approval; stopped, never auto-approved (PRD §11.5). */
  | "permission_prompt"
  /** Could not determine the outcome (e.g. daemon restarted mid-run). */
  | "unknown";

export interface AdapterResult {
  outcome: InvocationOutcome;
  exitCode: number | null;
  /** The CLI's final assistant message (expected to be JSON), or null if none was produced. */
  finalMessage: string | null;
  usage: Usage | null;
  durationMs: number;
  /** pid/pgid recorded in the journal for restart reconciliation. */
  pid: number | null;
}

export interface AdapterProbe {
  ok: boolean;
  /** Exact version string reported by the CLI; must equal AGENT.md `cli_version`. */
  version: string | null;
  detail: string;
}

export interface AgentAdapter {
  readonly cli: "codex" | "claude" | "pi";
  /** Check the CLI exists and report its version. Never installs anything. */
  probe(): Promise<AdapterProbe>;
  invoke(inv: AdapterInvocation): Promise<AdapterResult>;
}
