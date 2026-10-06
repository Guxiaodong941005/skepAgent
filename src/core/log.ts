import type { Sha } from "./ids.js";

/**
 * Contract between the git layer (`src/git/log-reader.ts`) and the pure reducer
 * (`src/core/reducer`). The git layer walks `git rev-list --first-parent --reverse main`, verifies
 * each commit's SSH signature against the LOCAL trust root, and produces one `LogEntry` per
 * commit. The reducer never touches git, the filesystem, or the clock.
 */

export type SignatureCheck =
  /** Good signature by a key in the local allowed_signers; `principal` is e.g. `human`, `daemon:mac`. */
  | { status: "good"; principal: string }
  | { status: "missing" }
  | { status: "bad"; detail: string }
  | { status: "unknown_key"; detail: string };

export type ChangeStatus = "A" | "M" | "D" | "T" | "R" | "C" | "other";

export interface FileChange {
  status: ChangeStatus;
  path: string;
}

export interface LogEntry {
  /** First-parent index on `main`; genesis = 0 (PRD §8.3). */
  seq: number;
  sha: Sha;
  /** All parents of the commit, in git order. Structural rule: exactly one for seq ≥ 1. */
  parents: Sha[];
  signature: SignatureCheck;
  /** Name-status diff against the first parent (genesis: against the empty tree). */
  changes: FileChange[];
  /**
   * UTF-8 content of each ADDED file, keyed by path. `null` when the file exceeds the size limit
   * (MAX_EVENT_BYTES + 1 bytes are read at most) or is not valid UTF-8.
   * Only files under `events/` and the genesis `skep.json` are read.
   */
  added: Record<string, string | null>;
}
