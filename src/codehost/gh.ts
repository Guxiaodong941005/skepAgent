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
 * never trusted beyond the fields this file reads. Flag values are passed as `--flag=value` and
 * a leading `-` in a repo or ref name is rejected, so a caller-supplied name cannot be parsed as
 * another option (SK-503 review note 1).
 *
 * Branch tips use `gh api repos/<owner>/<repo>/git/ref/heads/<branch>` (a 404 is "no such
 * branch"), not `git ls-remote`. That keeps one auth path — `gh`'s own — and never prompts
 * (SK-503 review note 2). This class makes no git call; `exec` still sets `GIT_TERMINAL_PROMPT=0`
 * for one, so adding a git call later cannot silently drop it.
 * Authentication is `gh`'s own local config on the daemon user (D19): this class adds no token,
 * env, or credential argument.
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
    const slug = await this.repoSlug(repo);
    // One auth path (gh), so a private repo does not fall back to git's credential helpers.
    // A missing ref is a 404; anything else is a real failure. Without a host named by a URL,
    // `--hostname` is omitted so gh uses its own configured default host (e.g. an Enterprise
    // install), never one hard-coded here (SK-507 review note 1).
    const hostArgs = slug.hostname === null ? [] : ["--hostname", slug.hostname];
    const result = await this.exec("gh", ["api", ...hostArgs, endpoint(slug, branch)], {
      missingOk: true,
    });
    if (result === null) return null;
    const parsed = parseJson(result.stdout, "api");
    if (!isRecord(parsed) || !isRecord(parsed.object) || typeof parsed.object.sha !== "string") {
      throw new CodeHostError(`gh api returned no sha for ${branch}`);
    }
    if (!SHA_RE.test(parsed.object.sha)) {
      throw new CodeHostError(`gh api returned a non-sha for ${branch}`);
    }
    return parsed.object.sha;
  }

  async findPr(repo: string, head: string): Promise<PrInfo | null> {
    assertRepo(repo);
    assertRefName(head, "head");
    // `gh pr list --head` is the idempotency lookup (PRD §9.6 step 9): reuse after a crash.
    const result = await this.gh([
      "pr",
      "list",
      flag("repo", repo),
      flag("head", head),
      flag("state", "open"),
      flag("json", VIEW_FIELDS),
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
      flag("repo", repo),
      flag("head", p.head),
      flag("base", p.base),
      flag("title", p.title),
      flag("body", p.body),
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
    await this.gh(["pr", "edit", flag("repo", repo), flag("base", base), String(pr)]);
  }

  async closePr(repo: string, pr: number, comment: string): Promise<void> {
    assertRepo(repo);
    assertPrNumber(pr);
    assertText(comment, "comment");
    await this.gh(["pr", "close", flag("repo", repo), flag("comment", comment), String(pr)]);
  }

  async prState(repo: string, pr: number): Promise<{ state: PrState; mergeSha: string | null }> {
    const view = await this.view(repo, String(pr));
    return { state: view.state, mergeSha: view.mergeSha };
  }

  private async view(repo: string, pr: string): Promise<PrInfo> {
    const result = await this.gh(["pr", "view", flag("repo", repo), flag("json", VIEW_FIELDS), pr]);
    return toInfo(parseView(parseJson(result.stdout, "pr view"), "pr view"));
  }

  /**
   * `owner/repo` for the git-ref API. A name is used as given, with no host (gh's default); an
   * https URL is reduced to its host and `owner/repo` path. The daemon never stores a credential
   * in either form (D19).
   */
  private async repoSlug(repo: string): Promise<{ hostname: string | null; name: string }> {
    if (!repo.includes("://")) return { hostname: null, name: repo };
    let url: URL;
    try {
      url = new URL(repo);
    } catch {
      throw new CodeHostError(`repo is not a usable https URL: ${JSON.stringify(repo)}`);
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      throw new CodeHostError("repo URL must be https without embedded credentials or a port");
    }
    const name = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    if (!/^[^/]+\/[^/]+$/.test(name)) {
      throw new CodeHostError(`repo URL does not name owner/repo: ${JSON.stringify(repo)}`);
    }
    return { hostname: url.hostname, name };
  }

  private async gh(args: string[]): Promise<ExecResult> {
    const result = await this.exec("gh", args);
    if (result === null) throw new CodeHostError("gh returned no result");
    return result;
  }

  /**
   * `missingOk` turns a 404 into null (an absent branch). Every other non-zero exit is a
   * failure. Git cannot prompt for credentials: `GIT_TERMINAL_PROMPT=0` on every git call
   * (SK-503 review note 2). No production path calls git; branch tips go through `gh api`.
   */
  protected async exec(
    file: string,
    args: string[],
    opts: { missingOk?: boolean } = {},
  ): Promise<ExecResult | null> {
    const env = file === "git" ? { ...this.env, GIT_TERMINAL_PROMPT: "0" } : this.env;
    const result = await this.run(file, args, { env, timeoutMs: this.timeoutMs });
    if (result.code !== 0) {
      if (opts.missingOk && isNotFound(result)) return null;
      throw ghFailed(`${file} ${args.join(" ")}`, result);
    }
    return result;
  }
}

/** `--flag=value`: a value that itself starts with `-` stays a value, never a new option. */
function flag(name: string, value: string): string {
  return `--${name}=${value}`;
}

/** Percent-encode each path segment so a branch name cannot add or escape a path segment. */
function endpoint(slug: { name: string }, branch: string): string {
  const repo = slug.name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const ref = branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `repos/${repo}/git/ref/heads/${ref}`;
}

/** gh reports a missing API resource as "HTTP 404" on stderr (and exits non-zero). */
function isNotFound(result: ExecResult): boolean {
  return /\b404\b/.test(result.stderr) || /\b404\b/.test(result.stdout);
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
  // A leading `-` would be parsed as a flag (`--repo=--web` is safe, `--repo --web` is not).
  if (repo.length === 0 || repo.length > 512 || repo.startsWith("-") || /[\0\r\n\t ]/.test(repo)) {
    throw new CodeHostError("repo must be a nonempty name or URL without whitespace");
  }
}

function assertRefName(name: string, what: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("-") ||
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
