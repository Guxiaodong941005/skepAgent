import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { GitError, NodeGitRunner } from "../git/runner.js";
import { PathEscapeError } from "../util/fs.js";
import { CodeMirror, CodeMirrorError } from "./worktree.js";

function currentUser(): { uid: number; gid: number } {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error("Worktree isolation tests require a POSIX user identity");
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

describe("allowlisted code mirrors and attempt worktrees", () => {
  const git = new NodeGitRunner();
  const branch = "skep/T-20261006-abcd/W1/e1";
  const path = "T-20261006-abcd/W1-e1";
  let root: string;
  let dir: string;
  let remote: string;
  let writer: string;
  let home: string;
  let worktreeRoot: string;
  let mirror: CodeMirror;
  let baseSha: string;

  beforeAll(async () => {
    root = await tempDir("code-mirror-");
    vi.stubEnv("HOME", root);
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(root, "case-"));
    remote = join(dir, "remote.git");
    writer = join(dir, "writer");
    home = join(dir, "skep-home");
    worktreeRoot = join(dir, "role", ".skep", "worktrees");
    await initRepo(remote, { bare: true });
    await initRepo(writer);
    baseSha = await commitFile(git, writer, "example.txt", "Base content\n");
    await git.run(["push", remote, `${baseSha}:refs/heads/main`], { cwd: writer });
    mirror = new CodeMirror({ git, home, worktreeRoot, repos: [{ name: "app", url: remote }] });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("initializes a private bare mirror per allowlisted repo and fetches idempotently", async () => {
    const mirrorDir = await mirror.fetch("app");
    expect(mirrorDir).toBe(join(home, "mirrors", "app.git"));
    expect(await mirror.fetch(`${remote}/`)).toBe(mirrorDir);
    expect((await stat(mirrorDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "mirrors"))).mode & 0o777).toBe(0o700);
    expect(
      (await git.run(["rev-parse", "--is-bare-repository"], { cwd: mirrorDir })).stdout.trim(),
    ).toBe("true");
    expect(
      (await git.run(["rev-parse", "refs/remotes/origin/main"], { cwd: mirrorDir })).stdout.trim(),
    ).toBe(baseSha);
    expect(
      (await git.run(["config", "--get", "remote.origin.url"], { cwd: mirrorDir })).stdout.trim(),
    ).toBe(remote);
    expect(await mirror.mirrorPath(remote.replace(/\.git$/, ""))).toBe(mirrorDir);
  });

  it("creates a fresh branch at the exact base commit and keeps Git administration daemon-owned", async () => {
    await commitFile(git, writer, "example.txt", "Later main content\n");
    await git.run(["push", remote, "HEAD:refs/heads/main"], { cwd: writer });
    const worktree = await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    expect(worktree).toEqual({
      repo: "app",
      mirrorDir: join(home, "mirrors", "app.git"),
      path: join(worktreeRoot, path),
      branch,
      baseSha,
    });
    expect((await git.run(["rev-parse", "HEAD"], { cwd: worktree.path })).stdout.trim()).toBe(
      baseSha,
    );
    expect(
      (await git.run(["symbolic-ref", "--short", "HEAD"], { cwd: worktree.path })).stdout.trim(),
    ).toBe(branch);
    expect(await readFile(join(worktree.path, "example.txt"), "utf8")).toBe("Base content\n");
    const pointer = await stat(join(worktree.path, ".git"));
    const admin = await stat(join(worktree.mirrorDir, "worktrees"));
    expect(pointer.uid).toBe(process.getuid?.());
    expect(admin.uid).toBe(process.getuid?.());
    expect(pointer.mode & 0o777).toBe(0o600);
    expect(admin.mode & 0o777).toBe(0o700);
  });

  it("starts the next stacked item from the predecessor's delivered head", async () => {
    const predecessor = await commitFile(git, writer, "predecessor.txt", "Delivered predecessor\n");
    await git.run(["push", remote, `${predecessor}:refs/heads/${branch}`], { cwd: writer });
    const next = await mirror.createWorktree({
      repo: remote,
      baseSha: predecessor,
      branch: "skep/T-20261006-abcd/W2/e1",
      path: "T-20261006-abcd/W2-e1",
    });
    expect((await git.run(["rev-parse", "HEAD"], { cwd: next.path })).stdout.trim()).toBe(
      predecessor,
    );
    expect(await readFile(join(next.path, "predecessor.txt"), "utf8")).toBe(
      "Delivered predecessor\n",
    );
  });

  it("hands off checkout content while protecting the daemon-owned .git pointer", async () => {
    const agentUser = currentUser();
    const isolated = new CodeMirror({
      git,
      home,
      worktreeRoot,
      agentUser,
      repos: [{ name: "app", url: remote }],
    });
    const attempt = await isolated.createWorktree({ repo: "app", baseSha, branch, path });
    const checkout = await stat(attempt.path);
    const file = await stat(join(attempt.path, "example.txt"));
    const pointer = await stat(join(attempt.path, ".git"));
    expect(file.uid).toBe(agentUser.uid);
    expect(file.gid).toBe(agentUser.gid);
    expect(checkout.uid).toBe(agentUser.uid);
    expect(checkout.gid).toBe(agentUser.gid);
    expect(checkout.mode & 0o7777).toBe(0o1770);
    expect(pointer.uid).toBe(agentUser.uid);
    expect(pointer.mode & 0o777).toBe(0o600);
    await writeFile(join(attempt.path, "example.txt"), "Agent edits\n");
    await writeFile(join(attempt.path, "new.txt"), "New agent file\n");
    expect(await readFile(join(attempt.path, "new.txt"), "utf8")).toBe("New agent file\n");
  });

  it("keeps attempt parents unwritable to agents even with a permissive daemon umask", async () => {
    const oldUmask = process.umask(0);
    try {
      const isolated = new CodeMirror({
        git,
        home,
        worktreeRoot,
        agentUser: currentUser(),
        repos: [{ name: "app", url: remote }],
      });
      const attempt = await isolated.createWorktree({ repo: "app", baseSha, branch, path });
      expect((await stat(worktreeRoot)).mode & 0o022).toBe(0);
      expect((await stat(dirname(attempt.path))).mode & 0o022).toBe(0);
      expect((await stat(attempt.path)).mode & 0o7777).toBe(0o1770);
    } finally {
      process.umask(oldUmask);
    }
  });

  it.skipIf(process.getuid?.() !== 0)(
    "keeps administration and symlink targets daemon-owned with a distinct agent uid/gid",
    async () => {
      const mappedId = async (file: string): Promise<number> => {
        if (process.platform !== "linux") return 65_534;
        const mappings = (await readFile(file, "utf8")).trim().split("\n");
        const available = mappings.some((line) => {
          const [first = 0, , count = 0] = line.trim().split(/\s+/).map(Number);
          return first <= 65_534 && 65_534 < first + count;
        });
        return available ? 65_534 : 0;
      };
      const agentUser = {
        uid: await mappedId("/proc/self/uid_map"),
        gid: await mappedId("/proc/self/gid_map"),
      };
      await writeFile(join(dir, "outside.txt"), "Daemon-owned target\n");
      await symlink(
        relative(join(worktreeRoot, path), join(dir, "outside.txt")),
        join(writer, "link"),
      );
      const sha = await commitFile(git, writer, "nested/example.txt", "Agent-owned content\n");
      await git.run(["add", "link"], { cwd: writer });
      const tip = await commitFile(git, writer, "example.txt", "Checkout with symlink\n");
      expect(tip).not.toBe(sha);
      await git.run(["push", remote, "HEAD:refs/heads/main"], { cwd: writer });
      const isolated = new CodeMirror({
        git,
        home,
        worktreeRoot,
        agentUser,
        repos: [{ name: "app", url: remote }],
      });
      const attempt = await isolated.createWorktree({ repo: "app", baseSha: tip, branch, path });
      expect((await stat(join(attempt.path, "nested/example.txt"))).uid).toBe(agentUser.uid);
      expect((await stat(join(attempt.path, "nested"))).gid).toBe(agentUser.gid);
      expect((await lstat(join(attempt.path, "link"))).uid).toBe(agentUser.uid);
      expect((await stat(join(dir, "outside.txt"))).uid).toBe(currentUser().uid);
      expect((await stat(join(attempt.path, "link"))).uid).toBe(currentUser().uid);
      expect((await stat(join(attempt.path, ".git"))).uid).toBe(currentUser().uid);
      expect((await stat(attempt.mirrorDir)).uid).toBe(currentUser().uid);
      await isolated.removeWorktree({ repo: "app", path });
    },
  );

  it("fetches with the injected daemon credentials and never an agent environment", async () => {
    const env = { SSH_AUTH_SOCK: join(dir, "daemon.sock") };
    const run = vi.spyOn(git, "run");
    try {
      const daemonMirror = new CodeMirror({
        git,
        home,
        worktreeRoot,
        repos: [{ name: "app", url: remote }],
        env,
      });
      await daemonMirror.fetch("app");
      const fetchCall = run.mock.calls.find(([args]) => args.includes("fetch"));
      expect(fetchCall?.[1].env).toEqual(env);
    } finally {
      run.mockRestore();
    }
  });

  it("refreshes remote branches and tags without pruning or overwriting attempt branches", async () => {
    const attempt = await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    const local = await commitFile(git, attempt.path, "local.txt", "Local attempt\n");
    const upstream = await commitFile(git, writer, "example.txt", "New upstream\n");
    await git.run(
      ["push", remote, `${upstream}:refs/heads/main`, `${upstream}:refs/heads/${branch}`],
      {
        cwd: writer,
      },
    );
    await git.run(["tag", "example", upstream], { cwd: writer });
    await git.run(["push", remote, "refs/tags/example"], { cwd: writer });
    const mirrorDir = await mirror.fetch("app");
    expect((await git.run(["rev-parse", "HEAD"], { cwd: attempt.path })).stdout.trim()).toBe(local);
    expect(
      (
        await git.run(["rev-parse", `refs/remotes/origin/${branch}`], { cwd: mirrorDir })
      ).stdout.trim(),
    ).toBe(upstream);
    expect(
      (await git.run(["rev-parse", "refs/tags/example"], { cwd: mirrorDir })).stdout.trim(),
    ).toBe(upstream);
    await git.run(["push", remote, `:refs/heads/${branch}`, ":refs/tags/example"], { cwd: writer });
    await mirror.fetch("app");
    expect((await git.run(["rev-parse", "HEAD"], { cwd: attempt.path })).stdout.trim()).toBe(local);
    expect(
      (
        await git.run(["show-ref", "--verify", `refs/remotes/origin/${branch}`], {
          cwd: mirrorDir,
          allowFailure: true,
        })
      ).code,
    ).not.toBe(0);
  });

  it("removes a clean registered worktree but retains its attempt branch", async () => {
    const attempt = await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    await mirror.removeWorktree({ repo: "app", path });
    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await git.run(["rev-parse", `refs/heads/${branch}`], { cwd: attempt.mirrorDir })
      ).stdout.trim(),
    ).toBe(baseSha);
    expect(
      (await git.run(["worktree", "list", "--porcelain"], { cwd: attempt.mirrorDir })).stdout,
    ).not.toContain(attempt.path);
  });

  it("preserves dirty worktrees unless removal explicitly requests force", async () => {
    const attempt = await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    await writeFile(join(attempt.path, "example.txt"), "Uncommitted work\n");
    await expect(mirror.removeWorktree({ repo: "app", path })).rejects.toThrow(GitError);
    expect(await readFile(join(attempt.path, "example.txt"), "utf8")).toBe("Uncommitted work\n");
    await mirror.removeWorktree({ repo: "app", path, force: true });
    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses all operations on repositories outside the local allowlist", async () => {
    const run = vi.spyOn(git, "run");
    try {
      await expect(mirror.init("other")).rejects.toThrow(CodeMirrorError);
      await expect(mirror.fetch("https://example.invalid/other.git")).rejects.toThrow(
        CodeMirrorError,
      );
      await expect(mirror.mirrorPath("other")).rejects.toThrow(CodeMirrorError);
      await expect(mirror.createWorktree({ repo: "other", baseSha, branch, path })).rejects.toThrow(
        CodeMirrorError,
      );
      await expect(mirror.removeWorktree({ repo: "other", path })).rejects.toThrow(CodeMirrorError);
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("rejects traversal, absolute paths, NULs, and symlink escapes on creation and removal", async () => {
    for (const invalidPath of ["../outside", dir, "a/../../outside", "a\0b", "a\\b", "."]) {
      await expect(
        mirror.createWorktree({ repo: "app", baseSha, branch, path: invalidPath }),
      ).rejects.toThrow(CodeMirrorError);
      await expect(mirror.removeWorktree({ repo: "app", path: invalidPath })).rejects.toThrow(
        CodeMirrorError,
      );
    }
    await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    await symlink(writer, join(worktreeRoot, "escape"));
    await expect(
      mirror.createWorktree({ repo: "app", baseSha, branch, path: "escape/attempt" }),
    ).rejects.toThrow(PathEscapeError);
    await expect(
      mirror.removeWorktree({ repo: "app", path: "escape/attempt", force: true }),
    ).rejects.toThrow(PathEscapeError);
    expect(await readFile(join(writer, "example.txt"), "utf8")).toBe("Base content\n");
  });

  it("rejects mirror symlinks that escape SKEP_HOME", async () => {
    await mirror.mirrorPath("app");
    await symlink(writer, join(home, "mirrors"));
    await expect(mirror.init("app")).rejects.toThrow(PathEscapeError);
  });

  it("refuses an existing checkout path or branch without resetting any work", async () => {
    const attempt = await mirror.createWorktree({ repo: "app", baseSha, branch, path });
    await writeFile(join(attempt.path, "example.txt"), "Keep this work\n");
    await expect(mirror.createWorktree({ repo: "app", baseSha, branch, path })).rejects.toThrow(
      /path already exists/,
    );
    await expect(
      mirror.createWorktree({ repo: "app", baseSha, branch, path: "another-attempt" }),
    ).rejects.toThrow(/branch already exists/);
    expect(await readFile(join(attempt.path, "example.txt"), "utf8")).toBe("Keep this work\n");
  });

  it.each(["-option", "bad..branch", "bad branch", "main:other", "HEAD"])(
    "rejects unsafe or invalid branch %j",
    async (invalidBranch) => {
      await expect(
        mirror.createWorktree({ repo: "app", baseSha, branch: invalidBranch, path }),
      ).rejects.toThrow(CodeMirrorError);
      await expect(stat(join(worktreeRoot, path))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects malformed, absent, and non-commit base SHAs", async () => {
    for (const sha of ["HEAD", "-option", "0".repeat(40)]) {
      await expect(
        mirror.createWorktree({ repo: "app", baseSha: sha, branch, path }),
      ).rejects.toThrow(CodeMirrorError);
    }
    const blob = (await git.run(["rev-parse", "HEAD:example.txt"], { cwd: writer })).stdout.trim();
    await expect(
      mirror.createWorktree({ repo: "app", baseSha: blob, branch, path }),
    ).rejects.toThrow(/fetched commit/);
  });

  it("does not convert a non-bare repository into a mirror", async () => {
    const mirrorDir = await mirror.mirrorPath("app");
    await initRepo(mirrorDir);
    await expect(mirror.init("app")).rejects.toThrow(/bare repository/);
    expect(
      (await git.run(["rev-parse", "--is-bare-repository"], { cwd: mirrorDir })).stdout.trim(),
    ).toBe("false");
  });

  it("uses distinct mirror directories for multiple allowlisted repositories", async () => {
    const otherRemote = join(dir, "other.git");
    await initRepo(otherRemote, { bare: true });
    const mirrors = new CodeMirror({
      git,
      home,
      worktreeRoot,
      repos: [
        { name: "app", url: remote },
        { name: "other", url: otherRemote },
      ],
    });
    expect(await mirrors.fetch("app")).toBe(join(home, "mirrors", "app.git"));
    expect(await mirrors.fetch("other")).toBe(join(home, "mirrors", "other.git"));
  });

  it("rejects malformed or ambiguous local allowlists", () => {
    const opts = { git, home, worktreeRoot };
    for (const repos of [
      [{ name: "../app", url: remote }],
      [{ name: "app", url: "-option" }],
      [{ name: "app", url: "https://example.invalid/app.git\n" }],
      [
        { name: "app", url: remote },
        { name: "app", url: "https://example.invalid/other.git" },
      ],
      [
        { name: "app", url: remote },
        { name: "other", url: `${remote}/` },
      ],
      [{ name: "app", url: remote, extra: "untrusted" }],
    ]) {
      expect(() => new CodeMirror({ ...opts, repos })).toThrow(CodeMirrorError);
    }
  });

  it("rejects incomplete or invalid agent identities", () => {
    const opts = { git, home, worktreeRoot, repos: [{ name: "app", url: remote }] };
    expect(() => new CodeMirror({ ...opts, agentUser: { uid: -1, gid: 1001 } })).toThrow(
      CodeMirrorError,
    );
    expect(() => new CodeMirror({ ...opts, agentUser: { uid: 1001, gid: 4_294_967_295 } })).toThrow(
      CodeMirrorError,
    );
    expect(
      () =>
        new CodeMirror({
          ...opts,
          ...{ agentUser: { uid: 1001 } },
        } as unknown as ConstructorParameters<typeof CodeMirror>[0]),
    ).toThrow(CodeMirrorError);
  });
});
