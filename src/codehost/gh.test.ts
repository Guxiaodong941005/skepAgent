import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../util/exec.js";
import { GhCodeHost, type GhCodeHostOptions, type GhRunner } from "./gh.js";
import { type CodeHost, CodeHostError } from "./types.js";

const REPO = "example/demo";
const SHA = "a".repeat(40);
const MERGE = "b".repeat(40);
const URL = "https://example.invalid/example/demo/pull/7";

function ok(stdout: string): ExecResult {
  return { code: 0, signal: null, stdout, stderr: "", timedOut: false };
}

function view(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    url: URL,
    title: "W1",
    state: "OPEN",
    headRefName: "skep/T-20260101-abcd/W1/e1",
    baseRefName: "main",
    mergeCommit: null,
    ...overrides,
  });
}

/** Records every invocation and answers from a script of stdout strings (or thrown errors). */
function stub(script: Array<string | ExecResult | Error>): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = vi.fn(async (file, args) => {
    calls.push([file, ...args]);
    const next = script.shift();
    if (next === undefined) throw new Error(`unexpected ${file} ${args.join(" ")}`);
    if (next instanceof Error) throw next;
    return typeof next === "string" ? ok(next) : next;
  });
  return { run, calls };
}

function ref(sha: string): string {
  return JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha } });
}

describe("GhCodeHost", () => {
  it("implements CodeHost through gh --json and never calls the network itself", async () => {
    const { run, calls } = stub([ref(SHA), "[]"]);
    const host: CodeHost = new GhCodeHost({ run, env: { PATH: "/usr/bin", HOME: "/tmp" } });
    expect(await host.remoteBranchSha(REPO, "main")).toBe(SHA);
    expect(await host.findPr(REPO, "skep/T-20260101-abcd/W1/e1")).toBeNull();
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ["gh", "api"],
      ["gh", "pr"],
    ]);
    expect(calls[0]).toContain("repos/example/demo/git/ref/heads/main");
    expect(calls[1]).toContain("--json=number,url,title,state,headRefName,baseRefName,mergeCommit");
    expect(calls[1]).toContain("--head=skep/T-20260101-abcd/W1/e1");
    expect(calls[1]).toContain("--repo=example/demo");
    expect(calls.flat()).not.toContain("ls-remote");
  });

  it("returns null when the ref API answers 404 and reads the sha otherwise", async () => {
    const missing = stub([
      { code: 1, signal: null, stdout: "", stderr: "gh: HTTP 404: not found\n", timedOut: false },
    ]);
    const host = new GhCodeHost({ run: missing.run, env: {} });
    expect(await host.remoteBranchSha(REPO, "missing")).toBeNull();

    const present = stub([ref(SHA)]);
    const presentHost = new GhCodeHost({ run: present.run, env: {} });
    expect(await presentHost.remoteBranchSha(REPO, "main")).toBe(SHA);
    expect(present.calls[0]).toEqual(["gh", "api", "repos/example/demo/git/ref/heads/main"]);
  });

  it("omits --hostname for an owner/repo name so gh uses its configured default host", async () => {
    const { run, calls } = stub([ref(SHA)]);
    const host = new GhCodeHost({ run, env: {} });
    expect(await host.remoteBranchSha("example/demo", "main")).toBe(SHA);
    expect(calls[0]).not.toContain("--hostname");
    expect(calls.flat().some((arg) => arg.includes("github.com"))).toBe(false);
  });

  it("resolves an https repo URL into the API host and owner/repo", async () => {
    const { run, calls } = stub([ref(SHA)]);
    const host = new GhCodeHost({ run, env: {} });
    expect(await host.remoteBranchSha("https://example.invalid/example/demo.git", "feat/one")).toBe(
      SHA,
    );
    expect(calls[0]).toEqual([
      "gh",
      "api",
      "--hostname",
      "example.invalid",
      "repos/example/demo/git/ref/heads/feat/one",
    ]);
  });

  it("creates a PR with gh pr create and reads it back with gh pr view --json", async () => {
    const { run, calls } = stub([`${URL}\n`, view()]);
    const host = new GhCodeHost({ run, env: { PATH: "/usr/bin" } });
    const created = await host.createPr(REPO, {
      head: "skep/T-20260101-abcd/W1/e1",
      base: "main",
      title: "W1",
      body: "first item",
    });
    expect(created).toEqual({
      number: 7,
      url: URL,
      head: "skep/T-20260101-abcd/W1/e1",
      base: "main",
      title: "W1",
      state: "open",
      mergeSha: null,
    });
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    expect(calls[0]).toContain(`--repo=${REPO}`);
    expect(calls[0]).toContain("--head=skep/T-20260101-abcd/W1/e1");
    expect(calls[0]).toContain("--base=main");
    expect(calls[0]).toContain("--title=W1");
    expect(calls[0]).toContain("--body=first item");
    expect(calls[1]?.slice(0, 3)).toEqual(["gh", "pr", "view"]);
    expect(calls[1]).toContain("--json=number,url,title,state,headRefName,baseRefName,mergeCommit");
    expect(calls[1]).toContain(URL);
  });

  it("findPr reuses the single open PR for a head and rejects two", async () => {
    const row = JSON.parse(view());
    const { run } = stub([JSON.stringify([row])]);
    const host = new GhCodeHost({ run, env: {} });
    expect(await host.findPr(REPO, row.headRefName)).toMatchObject({ number: 7, state: "open" });

    const again = stub([JSON.stringify([row, { ...row, number: 8 }])]);
    const dup = new GhCodeHost({ run: again.run, env: {} });
    await expect(dup.findPr(REPO, row.headRefName)).rejects.toThrow(/2 open pull requests/);
  });

  it("retargets with gh pr edit --base and closes with a comment", async () => {
    const { run, calls } = stub([ok(""), ok("")]);
    const host = new GhCodeHost({ run, env: {} });
    await host.retargetPr(REPO, 7, "main");
    await host.closePr(REPO, 7, "stale epoch");
    expect(calls[0]).toEqual(["gh", "pr", "edit", `--repo=${REPO}`, "--base=main", "7"]);
    expect(calls[1]).toEqual(["gh", "pr", "close", `--repo=${REPO}`, "--comment=stale epoch", "7"]);
  });

  it("maps pr view states and only reports a merge sha when merged", async () => {
    const open = stub([view({ state: "OPEN", mergeCommit: { oid: MERGE } })]);
    const host = new GhCodeHost({ run: open.run, env: {} });
    expect(await host.prState(REPO, 7)).toEqual({ state: "open", mergeSha: null });

    const merged = stub([view({ state: "MERGED", mergeCommit: { oid: MERGE } })]);
    const mergedHost = new GhCodeHost({ run: merged.run, env: {} });
    expect(await mergedHost.prState(REPO, 7)).toEqual({ state: "merged", mergeSha: MERGE });

    const closed = stub([view({ state: "CLOSED" })]);
    expect(await new GhCodeHost({ run: closed.run, env: {} }).prState(REPO, 7)).toEqual({
      state: "closed",
      mergeSha: null,
    });
  });

  it("fails closed on non-JSON output, unknown state, and a non-zero exit", async () => {
    const badJson = new GhCodeHost({ run: stub(["not json"]).run, env: {} });
    await expect(badJson.findPr(REPO, "main")).rejects.toBeInstanceOf(CodeHostError);

    const badState = new GhCodeHost({ run: stub([view({ state: "DRAFT" })]).run, env: {} });
    await expect(badState.prState(REPO, 7)).rejects.toThrow(/unknown pull request state/);

    const failed = new GhCodeHost({
      run: stub([{ code: 1, signal: null, stdout: "", stderr: "no such repo\n", timedOut: false }])
        .run,
      env: {},
    });
    await expect(failed.findPr(REPO, "main")).rejects.toThrow(/no such repo/);
  });

  it("rejects a created PR whose head does not match the request", async () => {
    const { run } = stub([`${URL}\n`, view({ headRefName: "somewhere-else" })]);
    const host = new GhCodeHost({ run, env: {} });
    await expect(
      host.createPr(REPO, {
        head: "skep/T-20260101-abcd/W1/e1",
        base: "main",
        title: "W1",
        body: "b",
      }),
    ).rejects.toThrow(/expected/);
  });

  it("passes only the given env and never reads GH_TOKEN from the parent", async () => {
    vi.stubEnv("GH_TOKEN", "must-not-leak");
    vi.stubEnv("GITHUB_TOKEN", "must-not-leak");
    const seen: Array<Record<string, string> | undefined> = [];
    const run: GhRunner = async (_file, _args, opts) => {
      seen.push(opts?.env);
      return ok("[]");
    };
    const host = new GhCodeHost({ run, env: { PATH: "/usr/bin", HOME: "/home/skep" } });
    await host.findPr(REPO, "main");
    expect(seen).toEqual([{ PATH: "/usr/bin", HOME: "/home/skep" }]);
    expect(JSON.stringify(seen)).not.toContain("must-not-leak");
    vi.unstubAllEnvs();
  });

  it("rejects repo names and branch names that could be split or escape a ref", async () => {
    const host = new GhCodeHost({ run: stub([]).run, env: {} });
    await expect(host.findPr("has space", "main")).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.remoteBranchSha(REPO, "refs/../heads/main")).rejects.toBeInstanceOf(
      CodeHostError,
    );
    await expect(host.retargetPr(REPO, 0, "main")).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.closePr(REPO, 1, "")).rejects.toBeInstanceOf(CodeHostError);
  });

  it("rejects a leading dash in repo and ref names before any command runs", async () => {
    const { run, calls } = stub([]);
    const host = new GhCodeHost({ run, env: {} });
    await expect(host.remoteBranchSha("--web", "main")).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.findPr(REPO, "--delete-branch")).rejects.toBeInstanceOf(CodeHostError);
    await expect(
      host.createPr(REPO, { head: "-h", base: "main", title: "t", body: "b" }),
    ).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.retargetPr(REPO, 7, "--web")).rejects.toBeInstanceOf(CodeHostError);
    await expect(
      host.remoteBranchSha("https://user:secret@example.invalid/example/demo", "main"),
    ).rejects.toBeInstanceOf(CodeHostError);
    expect(calls).toEqual([]);
  });

  it("disables credential prompts on a git call", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const run: GhRunner = async (_file, _args, opts) => {
      seen.push(opts?.env);
      return ok("");
    };
    // No production method calls git (tips go through `gh api`). Drive `exec` directly so the
    // no-prompt guard cannot be dropped unnoticed.
    const host = new (class extends GhCodeHost {
      constructor(opts: GhCodeHostOptions) {
        super(opts);
      }
      callGit(args: string[]) {
        return this.exec("git", args);
      }
    })({ run, env: { PATH: "/usr/bin", HOME: "/home/skep" } });
    await host.callGit(["version"]);
    expect(seen).toEqual([{ PATH: "/usr/bin", HOME: "/home/skep", GIT_TERMINAL_PROMPT: "0" }]);
  });

  it("fails closed when the ref API exits for a reason other than 404", async () => {
    const { run } = stub([
      {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "gh: HTTP 401: bad credentials\n",
        timedOut: false,
      },
    ]);
    const host = new GhCodeHost({ run, env: {} });
    await expect(host.remoteBranchSha(REPO, "main")).rejects.toThrow(/401/);
  });
});
