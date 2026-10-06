import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../util/exec.js";
import { GhCodeHost, type GhRunner } from "./gh.js";
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

describe("GhCodeHost", () => {
  it("implements CodeHost through gh --json and never calls the network itself", async () => {
    const { run, calls } = stub([
      JSON.stringify({ url: "https://example.invalid/example/demo" }),
      ok(`${SHA}\trefs/heads/main\n`),
      "[]",
    ]);
    const host: CodeHost = new GhCodeHost({ run, env: { PATH: "/usr/bin", HOME: "/tmp" } });
    expect(await host.remoteBranchSha(REPO, "main")).toBe(SHA);
    expect(await host.findPr(REPO, "skep/T-20260101-abcd/W1/e1")).toBeNull();
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["gh", "repo", "view"],
      ["git", "ls-remote", "--refs"],
      ["gh", "pr", "list"],
    ]);
    expect(calls[2]).toContain("--json");
    expect(calls[2]).toContain("--head");
    expect(calls[2]).toContain("skep/T-20260101-abcd/W1/e1");
  });

  it("returns null for a branch ls-remote does not list", async () => {
    const { run } = stub([JSON.stringify({ url: "https://example.invalid/example/demo" }), ok("")]);
    const host = new GhCodeHost({ run, env: {} });
    expect(await host.remoteBranchSha(REPO, "missing")).toBeNull();
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
    expect(calls[0]?.slice(0, 4)).toEqual(["gh", "pr", "create", "--repo"]);
    expect(calls[0]).toContain("--head");
    expect(calls[0]).toContain("--base");
    expect(calls[1]?.slice(0, 3)).toEqual(["gh", "pr", "view"]);
    expect(calls[1]).toContain("--json");
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
    expect(calls[0]).toEqual(["gh", "pr", "edit", "--repo", REPO, "--base", "main", "7"]);
    expect(calls[1]).toEqual([
      "gh",
      "pr",
      "close",
      "--repo",
      REPO,
      "--comment",
      "stale epoch",
      "7",
    ]);
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
});
