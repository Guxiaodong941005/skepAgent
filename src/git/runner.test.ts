import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { GitError, NodeGitRunner } from "./runner.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe("NodeGitRunner", () => {
  let dir: string;
  const git = new NodeGitRunner();

  beforeEach(async () => {
    dir = await tempDir("runner-");
    vi.stubEnv("HOME", dir);
    await initRepo(dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("passes shell metacharacters literally without executing them (AC 7)", async () => {
    const path = "literal;$(touch SHELL_EXPANDED)";
    const content = "safe content\n";
    await writeFile(join(dir, path), content);
    const result = await git.run(["hash-object", "--", path], { cwd: dir });
    const expected = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest("hex");
    expect(result).toEqual({ code: 0, stdout: `${expected}\n`, stderr: "" });
    await expect(access(join(dir, "SHELL_EXPANDED"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["hash-object", "--", path],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });

  it("inherits only allowlisted variables and explicit overrides, forcing a stable locale", async () => {
    vi.stubEnv("GIT_DIR", "/this-must-not-be-inherited");
    vi.stubEnv("GH_TOKEN", "test-secret");
    vi.stubEnv("SSH_AUTH_SOCK", join(dir, "agent.sock"));
    vi.stubEnv("TMPDIR", dir);
    await git.run(["--version"], {
      cwd: dir,
      env: { SKEP_TEST_OVERRIDE: "yes", LC_ALL: "hostile", GIT_TERMINAL_PROMPT: "1" },
    });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["--version"],
      expect.objectContaining({
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SSH_AUTH_SOCK: join(dir, "agent.sock"),
          TMPDIR: dir,
          SKEP_TEST_OVERRIDE: "yes",
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
        },
      }),
      expect.any(Function),
    );
  });

  it.each(["string", "bytes"])("writes %s input to stdin", async (kind) => {
    const input = "non-ASCII: café\n";
    const result = await git.run(["hash-object", "--stdin"], {
      cwd: dir,
      input: kind === "string" ? input : new Uint8Array(Buffer.from(input)),
    });
    expect(result.stdout.trim()).toBe(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(input)}\0${input}`)
        .digest("hex"),
    );
  });

  it("throws a typed error with arguments, exit code and diagnostics", async () => {
    const args = ["rev-parse", "--verify", "HEAD"];
    await expect(git.run(args, { cwd: dir })).rejects.toMatchObject({
      name: "GitError",
      args,
      code: 128,
      stderr: expect.stringContaining("Needed a single revision"),
    });
  });

  it("returns nonzero results only when allowFailure is explicit", async () => {
    const result = await git.run(["rev-parse", "--verify", "HEAD"], {
      cwd: dir,
      allowFailure: true,
    });
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("Needed a single revision");
  });

  it("reports a missing executable even with allowFailure", async () => {
    await expect(
      git.run(["--version"], { cwd: dir, env: { PATH: dir }, allowFailure: true }),
    ).rejects.toMatchObject({
      name: "GitError",
      code: -1,
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  });

  it("bounds subprocess execution with timeoutMs", async () => {
    const executable = join(dir, "git");
    await writeFile(executable, `#!${process.execPath}\nwhile (true) {}\n`);
    await chmod(executable, 0o700);
    await expect(
      git.run(["--version"], { cwd: dir, env: { PATH: dir }, timeoutMs: 100, allowFailure: true }),
    ).rejects.toMatchObject({
      name: "GitError",
      code: -1,
      cause: expect.objectContaining({ killed: true }),
    });
  });

  it("preserves the command error when it exits before consuming stdin", async () => {
    await expect(
      git.run(["--invalid-option"], { cwd: dir, input: new Uint8Array(1024 * 1024) }),
    ).rejects.toBeInstanceOf(GitError);
  });
});
