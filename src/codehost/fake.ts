import type { GitRunner } from "../git/runner.js";
import {
  type CodeHost,
  CodeHostError,
  type CreatePrParams,
  type PrInfo,
  type PrState,
} from "./types.js";

/**
 * In-memory pull-request registry over a local bare repo (ARCHITECTURE §11.5, sim invariant 5).
 *
 * Branch tips are read from the bare repo with the injected {@link GitRunner}; PR identity lives
 * only in memory, which is what the simulator needs (no network, deterministic numbers). The
 * registry asserts one PR per head branch in any state (sim invariant 5, §13.2): a second
 * `createPr` for the same head throws, whether the first is open, closed or merged, rather than
 * opening a duplicate the reducer could not tell apart.
 */

export interface FakeCodeHostOptions {
  git: GitRunner;
  /**
   * Bare code remote for the single `repo` this host serves. `remoteBranchSha` and `merge`
   * resolve refs here. Not a host path baked into source: callers pass a temp dir.
   */
  repoDir: string;
  /**
   * Allowlisted repo name or URL this bare remote belongs to. Calls for any other repo fail,
   * so two code repos cannot silently share one ref namespace.
   */
  repo: string;
  /**
   * URL prefix for `PrInfo.url`. Must be an http(s) origin with no trailing slash.
   * Defaults to a reserved example host so tests never name a real forge.
   */
  urlBase?: string;
}

const DEFAULT_URL_BASE = "https://example.invalid";

interface StoredPr extends PrInfo {
  repo: string;
  body: string;
}

export class FakeCodeHost implements CodeHost {
  private readonly git: GitRunner;
  private readonly repoDir: string;
  private readonly repo: string;
  private readonly urlBase: string;
  private nextNumber = 1;
  private readonly byNumber = new Map<number, StoredPr>();

  constructor(opts: FakeCodeHostOptions) {
    assertRepo(opts.repo);
    this.git = opts.git;
    this.repoDir = opts.repoDir;
    this.repo = opts.repo;
    this.urlBase = (opts.urlBase ?? DEFAULT_URL_BASE).replace(/\/+$/, "");
  }

  async remoteBranchSha(repo: string, branch: string): Promise<string | null> {
    this.assertOwnRepo(repo);
    assertRefName(branch, "branch");
    return this.revParse(branch);
  }

  async findPr(repo: string, head: string): Promise<PrInfo | null> {
    this.assertOwnRepo(repo);
    assertRefName(head, "head");
    const found = this.openForHead(repo, head);
    return found === undefined ? null : toInfo(found);
  }

  async createPr(repo: string, p: CreatePrParams): Promise<PrInfo> {
    this.assertOwnRepo(repo);
    assertRefName(p.head, "head");
    assertRefName(p.base, "base");
    assertText(p.title, "title");
    assertText(p.body, "body");
    if (p.head === p.base) {
      throw new CodeHostError(`pull request head and base are both ${p.head}`);
    }
    const existing = this.prForHead(repo, p.head);
    if (existing !== undefined) {
      // Invariant 5 (§13.2): at most one PR per head branch, in any state. A closed or merged PR
      // for the same head is still the one PR that head may have; callers that retry after a
      // crash must findPr (open) or prState (journaled number) and reuse it.
      throw new CodeHostError(
        `repo ${repo} already has pull request #${existing.number} (${existing.state}) for head ${p.head}`,
      );
    }
    const headSha = await this.revParse(p.head);
    if (headSha === null) {
      throw new CodeHostError(`head branch ${p.head} does not exist on the code remote`);
    }
    const baseSha = await this.revParse(p.base);
    if (baseSha === null) {
      throw new CodeHostError(`base branch ${p.base} does not exist on the code remote`);
    }
    const number = this.nextNumber;
    this.nextNumber += 1;
    const stored: StoredPr = {
      number,
      url: `${this.urlBase}/${encodeRepo(repo)}/pull/${number}`,
      head: p.head,
      base: p.base,
      title: p.title,
      state: "open",
      mergeSha: null,
      repo,
      body: p.body,
    };
    this.byNumber.set(number, stored);
    return toInfo(stored);
  }

  async retargetPr(repo: string, pr: number, base: string): Promise<void> {
    const stored = this.require(repo, pr);
    assertRefName(base, "base");
    if (stored.state !== "open") {
      throw new CodeHostError(
        `pull request #${pr} is ${stored.state}; only an open PR can be retargeted`,
      );
    }
    if (base === stored.head) {
      throw new CodeHostError(`pull request #${pr} cannot target its own head ${base}`);
    }
    if ((await this.revParse(base)) === null) {
      throw new CodeHostError(`base branch ${base} does not exist on the code remote`);
    }
    stored.base = base;
  }

  async closePr(repo: string, pr: number, comment: string): Promise<void> {
    const stored = this.require(repo, pr);
    assertText(comment, "comment");
    if (stored.state === "merged") {
      throw new CodeHostError(`pull request #${pr} is merged and cannot be closed`);
    }
    // Closing an already-closed PR is a no-op: reconciliation may retry it (§11.4).
    stored.state = "closed";
  }

  async prState(repo: string, pr: number): Promise<{ state: PrState; mergeSha: string | null }> {
    const stored = this.require(repo, pr);
    return { state: stored.state, mergeSha: stored.mergeSha };
  }

  /**
   * Scenario helper (not part of {@link CodeHost}): merge `pr` into its base on the bare repo and
   * record the resulting SHA. Fast-forwards when the head already contains the base; otherwise
   * writes a real merge commit (never a squash — PRD §9.4, stacked descendants must stay valid).
   * A conflict or a missing ref throws, so a scenario cannot record a merge the remote lacks.
   */
  async merge(pr: number): Promise<string> {
    const stored = this.byNumber.get(pr);
    if (stored === undefined) throw new CodeHostError(`pull request #${pr} does not exist`);
    if (stored.state !== "open") {
      throw new CodeHostError(`pull request #${pr} is ${stored.state} and cannot be merged`);
    }
    const headSha = await this.revParse(stored.head);
    const baseSha = await this.revParse(stored.base);
    if (headSha === null || baseSha === null) {
      throw new CodeHostError(`cannot merge #${pr}: head or base is missing on the code remote`);
    }
    // A fast-forward is only correct when base is already an ancestor of head *and* the two
    // have not diverged, i.e. the merge base is base itself. Anything else needs a merge commit
    // (PRD §9.4: squash would invalidate stacked descendants).
    const baseOf = await this.git.run(["merge-base", baseSha, headSha], {
      cwd: this.repoDir,
      allowFailure: true,
    });
    const fastForward = baseOf.code === 0 && baseOf.stdout.trim() === baseSha;
    const sha = fastForward ? headSha : await this.mergeCommit(stored, baseSha, headSha);
    if (fastForward) {
      const updated = await this.git.run(
        ["update-ref", `refs/heads/${stored.base}`, headSha, baseSha],
        { cwd: this.repoDir, allowFailure: true },
      );
      if (updated.code !== 0) {
        throw new CodeHostError(
          `failed to fast-forward ${stored.base}: ${updated.stderr.trim() || `exit ${updated.code}`}`,
        );
      }
    }
    stored.state = "merged";
    stored.mergeSha = sha;
    return sha;
  }

  /** Every PR this host has opened, open or not. Scenarios assert invariant 5 from this list. */
  list(repo?: string): PrInfo[] {
    const out: PrInfo[] = [];
    for (const stored of this.byNumber.values()) {
      if (repo === undefined || stored.repo === repo) out.push(toInfo(stored));
    }
    return out.sort((a, b) => a.number - b.number);
  }

  /**
   * Listing for sim invariant 5 (§13.2): `{ repo, head }` for every PR, in any state. Not part of
   * {@link CodeHost}; the simulator reads it to count PRs per head branch.
   */
  pullRequests(): readonly { repo: string; head: string; number: number; state: PrState }[] {
    return [...this.byNumber.values()]
      .sort((a, b) => a.number - b.number)
      .map((stored) => ({
        repo: stored.repo,
        head: stored.head,
        number: stored.number,
        state: stored.state,
      }));
  }

  /** Two-parent merge commit. `merge-tree --write-tree` exits non-zero on conflicts. */
  private async mergeCommit(stored: StoredPr, baseSha: string, headSha: string): Promise<string> {
    const merged = await this.git.run(["merge-tree", "--write-tree", baseSha, headSha], {
      cwd: this.repoDir,
      allowFailure: true,
    });
    if (merged.code !== 0) {
      throw new CodeHostError(
        `pull request #${stored.number} conflicts and cannot be merged: ${merged.stderr.trim()}`,
      );
    }
    const tree = merged.stdout.trim().split("\n")[0] ?? "";
    if (!SHA_RE.test(tree)) {
      throw new CodeHostError(`pull request #${stored.number} merge produced no tree`);
    }
    const commit = await this.git.run(
      [
        "commit-tree",
        tree,
        "-p",
        baseSha,
        "-p",
        headSha,
        "-m",
        `Merge pull request #${stored.number} from ${stored.head}\n`,
      ],
      { cwd: this.repoDir, env: MERGE_IDENTITY },
    );
    const sha = commit.stdout.trim();
    if (!SHA_RE.test(sha)) {
      throw new CodeHostError(`pull request #${stored.number} merge produced a non-sha`);
    }
    const updated = await this.git.run(["update-ref", `refs/heads/${stored.base}`, sha, baseSha], {
      cwd: this.repoDir,
      allowFailure: true,
    });
    if (updated.code !== 0) {
      throw new CodeHostError(
        `failed to update ${stored.base}: ${updated.stderr.trim() || `exit ${updated.code}`}`,
      );
    }
    return sha;
  }

  /** The open PR for a head, if any. `findPr` only reuses an open PR (§11.4). */
  private openForHead(repo: string, head: string): StoredPr | undefined {
    return this.prsForHead(repo, head).find((stored) => stored.state === "open");
  }

  /** Every PR for a head, in any state. Invariant 5 allows at most one. */
  private prForHead(repo: string, head: string): StoredPr | undefined {
    return this.prsForHead(repo, head)[0];
  }

  private prsForHead(repo: string, head: string): StoredPr[] {
    const found: StoredPr[] = [];
    for (const stored of this.byNumber.values()) {
      if (stored.repo === repo && stored.head === head) found.push(stored);
    }
    return found;
  }

  private assertOwnRepo(repo: string): void {
    assertRepo(repo);
    if (repo !== this.repo) {
      throw new CodeHostError(`fake code host serves ${this.repo}, not ${repo}`);
    }
  }

  private require(repo: string, pr: number): StoredPr {
    this.assertOwnRepo(repo);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new CodeHostError(`pull request number must be a positive integer, got ${pr}`);
    }
    const stored = this.byNumber.get(pr);
    if (stored === undefined || stored.repo !== repo) {
      throw new CodeHostError(`pull request #${pr} does not exist in repo ${repo}`);
    }
    return stored;
  }

  private async revParse(branch: string): Promise<string | null> {
    const result = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}`],
      { cwd: this.repoDir, allowFailure: true },
    );
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    if (!SHA_RE.test(sha)) {
      throw new CodeHostError(`code remote returned a non-sha for ${branch}: ${sha}`);
    }
    return sha;
  }
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Fixed identity so scenario merges are deterministic (no ambient git config, no clock). */
const MERGE_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Skep Fake Host",
  GIT_AUTHOR_EMAIL: "skep-fake-host@example.invalid",
  GIT_AUTHOR_DATE: "1791244800 +0000",
  GIT_COMMITTER_NAME: "Skep Fake Host",
  GIT_COMMITTER_EMAIL: "skep-fake-host@example.invalid",
  GIT_COMMITTER_DATE: "1791244800 +0000",
};

function toInfo(stored: StoredPr): PrInfo {
  return {
    number: stored.number,
    url: stored.url,
    head: stored.head,
    base: stored.base,
    title: stored.title,
    state: stored.state,
    mergeSha: stored.mergeSha,
  };
}

/** Repo names and URLs are passed to `gh` as one argument; reject anything a shell could split. */
function assertRepo(repo: string): void {
  // A leading `-` is rejected so a repo name can never be read as an option (SK-503 review note 1).
  if (repo.length === 0 || repo.length > 512 || repo.startsWith("-") || /[\0\r\n\t ]/.test(repo)) {
    throw new CodeHostError("repo must be a nonempty name or URL without whitespace");
  }
}

/**
 * Ref names the host interpolates into `refs/heads/…`. Git's own check would catch most of
 * these, but rejecting them here keeps a bad name from ever reaching the runner.
 */
function assertRefName(name: string, what: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{") ||
    /[\0\r\n\t ~^:?*[\\]/.test(name) ||
    name
      .split("/")
      .some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith("."))
  ) {
    throw new CodeHostError(`${what} is not a valid branch name: ${JSON.stringify(name)}`);
  }
}

function assertText(value: string, what: string): void {
  if (value.length === 0 || value.length > 16_000 || /[\0]/.test(value)) {
    throw new CodeHostError(`${what} must be nonempty text without NUL`);
  }
}

function encodeRepo(repo: string): string {
  return repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
