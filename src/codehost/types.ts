/**
 * Code host (ARCHITECTURE §11.5). The daemon observes and opens pull requests on the code remote
 * through this interface; the simulator injects {@link FakeCodeHost} instead of `gh`.
 *
 * `repo` is an allowlisted repo name or URL (PRD §11.5). Implementations must not invent
 * credentials: `gh` authenticates from the daemon user's own local config (D19).
 */

/** A pull request as the protocol records it (`work.delivered.pr_url` / `pr_number`). */
export interface PrInfo {
  /** Positive, host-assigned. Stable for the life of the PR. */
  number: number;
  /** HTTPS URL, suitable for `pr_url` (schema: `z.url()`, ≤ 512). */
  url: string;
  head: string;
  base: string;
  title: string;
  state: PrState;
  /** Set once the PR is merged; the SHA `item.merged.merge_sha` records. */
  mergeSha: string | null;
}

export type PrState = "open" | "closed" | "merged";

/** A code-host call that cannot be completed (missing branch, duplicate PR, bad `gh` output). */
export class CodeHostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeHostError";
  }
}

export interface CreatePrParams {
  head: string;
  base: string;
  title: string;
  body: string;
}

/**
 * Branch and pull-request operations the daemon needs (ARCHITECTURE §11.5).
 * Every method is idempotent where the protocol retries it: `findPr` before `createPr`,
 * `retargetPr`/`closePr` on an already-retargeted or already-closed PR.
 */
export interface CodeHost {
  /** Tip of `branch` on the code remote, or null when the branch does not exist. */
  remoteBranchSha(repo: string, branch: string): Promise<string | null>;
  /** Open PR whose head branch is `head`, or null. Used to reuse a PR after a crash (§11.4). */
  findPr(repo: string, head: string): Promise<PrInfo | null>;
  createPr(repo: string, p: CreatePrParams): Promise<PrInfo>;
  /** Point an open PR at a new base (stacked delivery retargets onto the merged base). */
  retargetPr(repo: string, pr: number, base: string): Promise<void>;
  /** Close an open PR, recording `comment` (stale epochs of the same item, §6.2). */
  closePr(repo: string, pr: number, comment: string): Promise<void>;
  prState(repo: string, pr: number): Promise<{ state: PrState; mergeSha: string | null }>;
}
