import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { NodeGitRunner } from "../git/runner.js";
import { BlackboardClone, BlackboardCloneError } from "./clone.js";

describe("private blackboard clone", () => {
  const git = new NodeGitRunner();
  let root: string;
  let remote: string;
  let clone: BlackboardClone;

  beforeAll(async () => {
    root = await tempDir("blackboard-clone-");
    vi.stubEnv("HOME", root);
  });

  beforeEach(async () => {
    const dir = await mkdtemp(join(root, "case-"));
    remote = join(dir, "remote.git");
    await initRepo(remote, { bare: true });
    clone = new BlackboardClone({ git, dir: join(dir, "clone"), remoteUrl: remote });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("initializes a private non-bare main clone with exactly the two refspecs, idempotently", async () => {
    await clone.init();
    await clone.init();
    expect((await stat(clone.dir)).mode & 0o777).toBe(0o700);
    expect(
      (await git.run(["rev-parse", "--is-bare-repository"], { cwd: clone.dir })).stdout.trim(),
    ).toBe("false");
    expect((await git.run(["symbolic-ref", "HEAD"], { cwd: clone.dir })).stdout.trim()).toBe(
      "refs/heads/main",
    );
    expect(
      (await git.run(["config", "--get-all", "remote.origin.fetch"], { cwd: clone.dir })).stdout
        .trim()
        .split("\n"),
    ).toEqual([
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/hb/*:refs/remotes/origin/hb/*",
    ]);
  });

  it("fetches main and heartbeat refs, then discards divergent local commits by hard reset", async () => {
    const writer = join(root, "writer");
    await initRepo(writer);
    const tip = await commitFile(git, writer, "skep.json", "{}\n");
    await git.run(["push", remote, `${tip}:refs/heads/main`, `${tip}:refs/heads/hb/mac.coding`], {
      cwd: writer,
    });
    await clone.init();
    await clone.fetch();
    expect(await clone.resetToRemoteMain()).toBe(tip);
    expect(
      (
        await git.run(["rev-parse", "refs/remotes/origin/hb/mac.coding"], { cwd: clone.dir })
      ).stdout.trim(),
    ).toBe(tip);
    const local = await commitFile(git, clone.dir, "local.txt", "Discard this local attempt\n");
    expect(local).not.toBe(tip);
    expect(await clone.resetToRemoteMain()).toBe(tip);
    expect((await git.run(["status", "--porcelain"], { cwd: clone.dir })).stdout).toBe("");
    await git.run(["push", remote, ":refs/heads/hb/mac.coding"], { cwd: writer });
    await clone.fetch();
    expect(
      (
        await git.run(["show-ref", "--verify", "refs/remotes/origin/hb/mac.coding"], {
          cwd: clone.dir,
          allowFailure: true,
        })
      ).code,
    ).not.toBe(0);
  });

  it("refuses bare repositories and malformed remote URLs", async () => {
    const bare = new BlackboardClone({ git, dir: remote, remoteUrl: remote });
    await expect(bare.init()).rejects.toThrow(BlackboardCloneError);
    expect(() => new BlackboardClone({ git, dir: clone.dir, remoteUrl: "" })).toThrow(
      BlackboardCloneError,
    );
    expect(
      () => new BlackboardClone({ git, dir: clone.dir, remoteUrl: "example.invalid\n" }),
    ).toThrow(BlackboardCloneError);
  });
});
