import type { ExecOptions, ExecResult } from "../util/exec.js";
import { execFileChecked } from "../util/exec.js";
import {
  type CodeHost,
  CodeHostError,
  type CreatePrParams,
  type PrInfo,
  type PrState,
} from "./types.js";

/**
 * GitHub code host via the `gh` CLI (ARCHITECTURE §11.5).
 *
 * Commands follow the documented invocations: `gh pr list --head`, `gh pr create`,
 * `gh pr edit --base`, `gh pr close`, `gh pr view --json`. Output is `--json`, parsed here and
 * never trusted beyond the fields this file reads. Branch tips use `git ls-remote` against the
 * repo's fetch URL (`gh repo view --json url`), not the REST API. Authentication is `gh`'s own
 * local config on the daemon user (D19): this class adds no token, env, or credential argument.
 */

/** Subset of {@link execFileChecked} the stub runner in tests implements. */
export type GhRunner = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface GhCodeHostOptions {
  /** Defaults to {@link execFileChecked}. Tests pass a stub so no `gh` or `git` binary runs. */
  run?: GhRunner;
  /**
   * Environment passed through to `gh` and `git`. Defaults to a minimal PATH/HOME so `gh` can
   * find its binary and the daemon user's own config. Never includes `GH_TOKEN`/`GITHUB_TOKEN`
   * from the parent unless the caller deliberately put them here (the daemon must not, D19).
   */
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface GhPrView {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
}

const VIEW_FIELDS = "number,url,title,state,headRefName,baseRefName,mergeCommit";

export class GhCodeHost implements CodeHost {
  private readonly run: GhRunner;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number | undefined;

  constructor(opts: GhCodeHostOptions = {}) {
    this.run = opts.run ?? execFileChecked;
    this.env = opts.env ?? defaultEnv();
    this.timeoutMs = opts.timeoutMs;
  }

  async remoteBranchSha(repo: string, branch: string): Promise<string | null> {
    assertRepo(repo);
    assertRefName(branch, "branch");
    const url = await this.fetchUrl(repo);
    // ls-remote prints nothing and exits 0 when the ref is absent.
    const result = await this.exec("git", ["ls-remote", "--refs", url, `refs/heads/${branch}`]);
    const line = result.stdout.trim();
    if (line === "") return null;
    const sha = line.split(/\s+/)[0] ?? "";
    if (!SHA_RE.test(sha)) {
      throw new CodeHostError(`git ls-remote returned a non-sha for ${branch}: ${line}`);
    }
    return sha;
  }

  async findPr(repo: string, head: string): Promise<PrInfo | null> {
    assertRepo(repo);
    assertRefName(head, "head");
    // `gh pr list --head` is the idempotency lookup (PRD §9.6 step 9): reuse after a crash.
    const result = await this.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "open",
      "--json",
      VIEW_FIELDS,
    ]);
    const rows = parseJson(result.stdout, "pr list");
    if (!Array.isArray(rows)) {
      throw new CodeHostError("gh pr list did not return a JSON array");
    }
    const matches = rows.filter((row) => isRecord(row) && row.headRefName === head);
    if (matches.length > 1) {
      throw new CodeHostError(
        `repo ${repo} has ${matches.length} open pull requests for head ${head}`,
      );
    }
    const first = matches[0];
    return first === undefined ? null : toInfo(parseView(first, "pr list"));
  }

  async createPr(repo: string, p: CreatePrParams): Promise<PrInfo> {
    assertRepo(repo);
    assertRefName(p.head, "head");
    assertRefName(p.base, "base");
    assertText(p.title, "title");
    assertText(p.body, "body");
    const result = await this.gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      p.head,
      "--base",
      p.base,
      "--title",
      p.title,
      "--body",
      p.body,
    ]);
    const url = result.stdout.trim().split("\n").at(-1) ?? "";
    if (!/^https:\/\/\S+$/.test(url)) {
      throw new CodeHostError(
        `gh pr create did not print a pull request URL: ${JSON.stringify(url)}`,
      );
    }
    const view = await this.view(repo, url);
    if (view.head !== p.head || view.base !== p.base) {
      throw new CodeHostError(
        `gh created #${view.number} for ${view.head} → ${view.base}, expected ${p.head} → ${p.base}`,
      );
    }
    return view;
  }

  async retargetPr(repo: string, pr: number, base: string): Promise<void> {
    assertRepo(repo);
    assertPrNumber(pr);
    assertRefName(base, "base");
    await this.gh(["pr", "edit", "--repo", repo, "--base", base, String(pr)]);
  }

  async closePr(repo: string, pr: number, comment: string): Promise<void> {
    assertRepo(repo);
    assertPrNumber(pr);
    assertText(comment, "comment");
    await this.gh(["pr", "close", "--repo", repo, "--comment", comment, String(pr)]);
  }

  async prState(repo: string, pr: number): Promise<{ state: PrState; mergeSha: string | null }> {
    const view = await this.view(repo, String(pr));
    return { state: view.state, mergeSha: view.mergeSha };
  }

  private async view(repo: string, pr: string): Promise<PrInfo> {
    const result = await this.gh(["pr", "view", "--repo", repo, "--json", VIEW_FIELDS, pr]);
    return toInfo(parseView(parseJson(result.stdout, "pr view"), "pr view"));
  }

  /** `gh repo view --json url` is the fetch URL; the daemon never stores a credential in it. */
  private async fetchUrl(repo: string): Promise<string> {
    const result = await this.gh(["repo", "view", "--json", "url", "--repo", repo]);
    const parsed = parseJson(result.stdout, "repo view");
    if (
      !isRecord(parsed) ||
      typeof parsed.url !== "string" ||
      !/^https:\/\/\S+$/.test(parsed.url)
    ) {
      throw new CodeHostError("gh repo view did not return an https url");
    }
    return parsed.url;
  }

  private gh(args: string[]): Promise<ExecResult> {
    return this.exec("gh", args);
  }

  private async exec(file: string, args: string[]): Promise<ExecResult> {
    const result = await this.run(file, args, { env: this.env, timeoutMs: this.timeoutMs });
    if (result.code !== 0) throw ghFailed(`${file} ${args.join(" ")}`, result);
    return result;
  }
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** PATH and HOME only: enough for `gh` to start and read its own config. No tokens (D19). */
function defaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CodeHostError(`gh ${what} returned non-JSON output`, { cause: error });
  }
}

function parseView(raw: unknown, what: string): GhPrView {
  if (!isRecord(raw)) throw new CodeHostError(`gh ${what} returned a non-object`);
  const number = raw.number;
  const url = raw.url;
  const title = raw.title;
  const state = raw.state;
  const headRefName = raw.headRefName;
  const baseRefName = raw.baseRefName;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof state !== "string" ||
    typeof headRefName !== "string" ||
    typeof baseRefName !== "string"
  ) {
    throw new CodeHostError(`gh ${what} is missing required pull request fields`);
  }
  const merge = raw.mergeCommit;
  let oid: string | null = null;
  if (merge !== null && merge !== undefined) {
    if (!isRecord(merge) || typeof merge.oid !== "string") {
      throw new CodeHostError(`gh ${what} has an unreadable mergeCommit`);
    }
    oid = merge.oid;
  }
  return {
    number,
    url,
    title,
    state,
    headRefName,
    baseRefName,
    mergeCommit: oid === null ? null : { oid },
  };
}

function toInfo(view: GhPrView): PrInfo {
  return {
    number: view.number,
    url: view.url,
    head: view.headRefName,
    base: view.baseRefName,
    title: view.title,
    state: mapState(view.state),
    mergeSha: view.state === "MERGED" ? (view.mergeCommit?.oid ?? null) : null,
  };
}

function mapState(state: string): PrState {
  switch (state) {
    case "OPEN":
      return "open";
    case "CLOSED":
      return "closed";
    case "MERGED":
      return "merged";
    default:
      throw new CodeHostError(`gh returned an unknown pull request state ${JSON.stringify(state)}`);
  }
}

function ghFailed(what: string, result: ExecResult): CodeHostError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new CodeHostError(
    detail === ""
      ? `gh ${what} exited ${result.code}`
      : `gh ${what} exited ${result.code}: ${detail}`,
  );
}

function assertRepo(repo: string): void {
  if (repo.length === 0 || repo.length > 512 || /[\0\r\n\t ]/.test(repo)) {
    throw new CodeHostError("repo must be a nonempty name or URL without whitespace");
  }
}

function assertRefName(name: string, what: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..") ||
    /[\0\r\n\t ~^:?*[\\]/.test(name)
  ) {
    throw new CodeHostError(`${what} is not a valid branch name: ${JSON.stringify(name)}`);
  }
}

function assertPrNumber(pr: number): void {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new CodeHostError(`pull request number must be a positive integer, got ${pr}`);
  }
}

function assertText(value: string, what: string): void {
  if (value.length === 0 || value.length > 16_000 || /[\0]/.test(value)) {
    throw new CodeHostError(`${what} must be nonempty text without NUL`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
