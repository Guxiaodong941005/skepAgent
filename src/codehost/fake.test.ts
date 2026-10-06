import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { NodeGitRunner } from "../git/runner.js";
import { FakeCodeHost } from "./fake.js";
import { type CodeHost, CodeHostError } from "./types.js";

const REPO = "example/demo";

describe("FakeCodeHost", () => {
  const dirs: string[] = [];
  const git = new NodeGitRunner();

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function bareRepo(): Promise<{ dir: string; work: string; host: FakeCodeHost }> {
    const parent = await tempDir("codehost-");
    dirs.push(parent);
    const dir = join(parent, "code.git");
    await initRepo(dir, { bare: true });
    // commitFile needs a work tree; seed the bare repo by pushing from one.
    const work = join(parent, "work");
    await initRepo(work);
    await git.run(["remote", "add", "origin", dir], { cwd: work });
    await commitFile(git, work, "README.md", "demo\n");
    // commitFile writes objects with plumbing and moves HEAD, so a refspec push would send
    // the tip without its parents. --all publishes the objects the bare repo must merge.
    await git.run(["push", "--all", "origin"], { cwd: work });
    return { dir, work, host: new FakeCodeHost({ git, repoDir: dir, repo: REPO }) };
  }

  it("implements CodeHost and reads branch tips from the bare repo", async () => {
    const { host } = await bareRepo();
    const codehost: CodeHost = host;
    const sha = await codehost.remoteBranchSha(REPO, "main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await codehost.remoteBranchSha(REPO, "missing")).toBeNull();
    expect(await codehost.findPr(REPO, "skep/T-20260101-abcd/W1/e1")).toBeNull();
  });

  it("opens one PR per head branch and refuses a second", async () => {
    const { dir, host } = await bareRepo();
    const work = join(dir, "..", "work");
    const head = "skep/T-20260101-abcd/W1/e1";
    await git.run(["checkout", "-b", head], { cwd: work });
    const tip = await commitFile(git, work, "src/app.ts", "export const n = 1;\n");
    await git.run(["push", "--all", "origin"], { cwd: work });

    const created = await host.createPr(REPO, {
      head,
      base: "main",
      title: "W1",
      body: "first item",
    });
    expect(created).toMatchObject({
      number: 1,
      url: `https://example.invalid/${REPO}/pull/1`,
      head,
      base: "main",
      title: "W1",
      state: "open",
      mergeSha: null,
    });
    expect(await host.findPr(REPO, head)).toEqual(created);
    expect(await host.remoteBranchSha(REPO, head)).toBe(tip);

    await expect(
      host.createPr(REPO, { head, base: "main", title: "again", body: "duplicate" }),
    ).rejects.toBeInstanceOf(CodeHostError);
    expect(host.list(REPO)).toHaveLength(1);

    // A different head is a different PR. Numbers stay monotonic across repos.
    const other = "skep/T-20260101-abcd/W2/e1";
    await git.run(["checkout", "-b", other], { cwd: work });
    await commitFile(git, work, "src/ui.ts", "export const ui = 1;\n");
    await git.run(["push", "--all", "origin"], { cwd: work });
    const second = await host.createPr(REPO, {
      head: other,
      base: head,
      title: "W2",
      body: "stacked",
    });
    expect(second.number).toBe(2);
    expect(second.base).toBe(head);
  });

  it("retargets an open PR and refuses to retarget a closed one", async () => {
    const { host, head } = await stacked();
    await host.retargetPr(REPO, 2, "main");
    expect((await host.findPr(REPO, head))?.base).toBe("main");
    // Retargeting again to the same base is idempotent.
    await host.retargetPr(REPO, 2, "main");

    await host.closePr(REPO, 2, "superseded by epoch 2");
    expect(await host.prState(REPO, 2)).toEqual({ state: "closed", mergeSha: null });
    // Reconciliation may retry a close (§11.4); a second close is a no-op.
    await host.closePr(REPO, 2, "already closed");
    await expect(host.retargetPr(REPO, 2, "main")).rejects.toBeInstanceOf(CodeHostError);
  });

  it("merges with a real merge commit and records its sha", async () => {
    const { dir, host } = await stacked();
    const mergeSha = await host.merge(1);
    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await host.prState(REPO, 1)).toEqual({ state: "merged", mergeSha });
    const remote = await host.remoteBranchSha(REPO, "main");
    expect(remote).toBe(mergeSha);

    const parents = (
      await git.run(["rev-list", "--parents", "-n", "1", mergeSha], { cwd: dir })
    ).stdout
      .trim()
      .split(" ");
    expect(parents).toHaveLength(3);

    // The stacked PR can now be retargeted onto the merged base and merged in turn.
    await host.retargetPr(REPO, 2, "main");
    const second = await host.merge(2);
    expect(await host.remoteBranchSha(REPO, "main")).toBe(second);
    const tip = (await git.run(["rev-parse", "refs/heads/main"], { cwd: dir })).stdout.trim();
    expect(tip).toBe(second);
    await expect(host.merge(2)).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.closePr(REPO, 1, "too late")).rejects.toThrow(/merged/);
  });

  it("fast-forwards when the head already contains the base", async () => {
    const { dir, host } = await bareRepo();
    const work = join(dir, "..", "work");
    await git.run(["checkout", "-b", "feature"], { cwd: work });
    await commitFile(git, work, "a.txt", "a\n");
    await git.run(["push", "--all", "origin"], { cwd: work });
    await host.createPr(REPO, { head: "feature", base: "main", title: "ff", body: "ff" });
    const sha = await host.merge(1);
    const parents = (await git.run(["rev-list", "--parents", "-n", "1", sha], { cwd: dir })).stdout
      .trim()
      .split(" ");
    expect(parents).toHaveLength(2);
    expect(await host.remoteBranchSha(REPO, "main")).toBe(sha);
  });

  it("rejects a PR whose head or base is not on the remote", async () => {
    const { host } = await bareRepo();
    await expect(
      host.createPr(REPO, { head: "nope", base: "main", title: "x", body: "y" }),
    ).rejects.toThrow(/does not exist/);
    await expect(host.remoteBranchSha(REPO, "../main")).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.remoteBranchSha("has space", "main")).rejects.toBeInstanceOf(CodeHostError);
  });

  it("refuses a second PR for a head in any state and lists every PR", async () => {
    const { dir, host } = await bareRepo();
    const work = join(dir, "..", "work");
    const head = "feature";
    await git.run(["checkout", "-b", head], { cwd: work });
    await commitFile(git, work, "a.txt", "a\n");
    await git.run(["push", "--all", "origin"], { cwd: work });
    const first = await host.createPr(REPO, { head, base: "main", title: "one", body: "one" });

    await host.closePr(REPO, first.number, "closed");
    // Invariant 5 (§13.2) counts every state: closing the PR does not free the head.
    await expect(
      host.createPr(REPO, { head, base: "main", title: "two", body: "two" }),
    ).rejects.toThrow(/already has pull request #1 \(closed\)/);
    // A closed PR is not reusable through findPr, which only sees open PRs (§11.4).
    expect(await host.findPr(REPO, head)).toBeNull();

    const merged = "feature-merged";
    await git.run(["checkout", "-b", merged], { cwd: work });
    await commitFile(git, work, "b.txt", "b\n");
    await git.run(["push", "--all", "origin"], { cwd: work });
    const second = await host.createPr(REPO, {
      head: merged,
      base: "main",
      title: "two",
      body: "two",
    });
    await host.merge(second.number);
    await expect(
      host.createPr(REPO, { head: merged, base: "main", title: "again", body: "again" }),
    ).rejects.toThrow(/\(merged\)/);

    expect(host.pullRequests()).toEqual([
      { repo: REPO, head, number: 1, state: "closed" },
      { repo: REPO, head: merged, number: 2, state: "merged" },
    ]);
    expect(host.list(REPO).map((pr) => pr.number)).toEqual([1, 2]);
    await expect(host.findPr("example/other", head)).rejects.toThrow(/serves/);
  });

  it("rejects a leading dash in repo and ref names", async () => {
    const { host } = await bareRepo();
    await expect(host.remoteBranchSha("--repo", "main")).rejects.toBeInstanceOf(CodeHostError);
    await expect(host.remoteBranchSha(REPO, "--delete")).rejects.toBeInstanceOf(CodeHostError);
    await expect(
      host.createPr(REPO, { head: "-h", base: "main", title: "t", body: "b" }),
    ).rejects.toBeInstanceOf(CodeHostError);
    expect(host.pullRequests()).toEqual([]);
  });

  async function stacked(): Promise<{
    dir: string;
    host: FakeCodeHost;
    work: string;
    head: string;
  }> {
    const { dir, work, host } = await bareRepo();
    const w1 = "skep/T-20260101-abcd/W1/e1";
    const w2 = "skep/T-20260101-abcd/W2/e1";
    await git.run(["checkout", "-b", w1], { cwd: work });
    await commitFile(git, work, "src/app.ts", "export const n = 1;\n");
    // Advance main after the branch point so merging needs a real merge commit, not a
    // fast-forward (PRD §9.4: stacked descendants stay valid only with a merge commit).
    await git.run(["checkout", "main"], { cwd: work });
    await commitFile(git, work, "CHANGELOG.md", "unreleased\n");
    await git.run(["checkout", "-b", w2, w1], { cwd: work });
    await commitFile(git, work, "src/ui.ts", "export const ui = 1;\n");
    await git.run(["push", "--all", "origin"], { cwd: work });
    await host.createPr(REPO, { head: w1, base: "main", title: "W1", body: "base item" });
    await host.createPr(REPO, { head: w2, base: w1, title: "W2", body: "stacked" });
    return { dir, host, work, head: w2 };
  }
});
