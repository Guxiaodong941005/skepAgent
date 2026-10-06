import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { type GitRunner, NodeGitRunner } from "../git/runner.js";
import { ExecError, type ExecResult, execFileChecked } from "../util/exec.js";
import { SecretScanError, type SecretScanOptions, scanSecrets } from "./secret-scan.js";
import { CodeMirror } from "./worktree.js";

function missingExecutable(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || missingExecutable(error.cause))
  );
}

describe("gitleaks secret scan", () => {
  const dirs: string[] = [];
  let options: SecretScanOptions;
  let mirrorDir: string;
  let git: { run: ReturnType<typeof vi.fn<GitRunner["run"]>> };
  let mirror: { mirrorPath: ReturnType<typeof vi.fn<CodeMirror["mirrorPath"]>> };
  const result: ExecResult = { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };

  beforeEach(async () => {
    const root = await tempDir("secret-scan-");
    dirs.push(root);
    const cwd = path.join(root, "worktree");
    const scratchDir = path.join(root, "daemon");
    mirrorDir = path.join(root, "mirror.git");
    await Promise.all([cwd, scratchDir, mirrorDir].map((dir) => mkdir(dir, { mode: 0o700 })));
    options = {
      repo: "app",
      cwd,
      scratchDir,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      env: {
        home: root,
        user: "agent",
        source: {
          PATH: "example-bin",
          GIT_ASKPASS: "blocked",
          SSH_AUTH_SOCK: "blocked",
          GH_TOKEN: "blocked",
          GITLEAKS_CONFIG: path.join(cwd, ".gitleaks.toml"),
          GITLEAKS_CONFIG_TOML: "[allowlist]\nregexes = ['.*']\n",
        },
      },
    };
    git = { run: vi.fn<GitRunner["run"]>() };
    mirror = { mirrorPath: vi.fn<CodeMirror["mirrorPath"]>().mockResolvedValue(mirrorDir) };
    trustedFiles({});
  });

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function trustedFiles(files: Record<string, string>) {
    git.run.mockImplementation(async (args) => {
      const file = args.at(-1) ?? "";
      if (args[0] === "ls-tree") {
        return {
          code: 0,
          stderr: "",
          stdout: Object.hasOwn(files, file) ? `100644 blob ${"c".repeat(40)}\t${file}\0` : "",
        };
      }
      if (args[0] === "show") {
        const name = (args[1] ?? "").slice(options.baseSha.length + 1);
        if (!Object.hasOwn(files, name)) throw new Error("Unexpected pinned configuration read");
        return { code: 0, stdout: files[name] ?? "", stderr: "" };
      }
      throw new Error("Unexpected Git command");
    });
  }

  function scanArgs(args: string[]) {
    const config = args[args.indexOf("--config") + 1];
    const ignore = args[args.indexOf("--gitleaks-ignore-path") + 1];
    if (!config || !ignore) throw new Error("Expected explicit scanner config and ignore paths");
    return { config, ignore };
  }

  it("uses private default configuration and an empty ignore file, rejects worktree suppressions and clears config env", async () => {
    await writeFile(path.join(options.cwd, ".gitleaks.toml"), "[allowlist]\nregexes = ['.*']\n");
    await writeFile(path.join(options.cwd, ".gitleaksignore"), "untrusted fingerprint\n");
    let configPath = "";
    let ignorePath = "";
    const exec = vi.fn<typeof execFileChecked>().mockImplementation(async (_file, args) => {
      const paths = scanArgs(args);
      configPath = paths.config;
      ignorePath = paths.ignore;
      expect(await readFile(configPath, "utf8")).toBe("[extend]\nuseDefault = true\n");
      expect(await readFile(ignorePath, "utf8")).toBe("");
      expect(path.dirname(configPath)).toBe(path.dirname(ignorePath));
      expect(path.dirname(path.dirname(configPath))).toBe(options.scratchDir);
      expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
      for (const file of [configPath, ignorePath])
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      return result;
    });
    expect(await scanSecrets(options, { git, mirror, exec })).toEqual({ status: "clean" });
    expect(exec).toHaveBeenCalledWith(
      "gitleaks",
      [
        "git",
        "--no-banner",
        "--redact",
        "--exit-code=42",
        "--config",
        configPath,
        "--gitleaks-ignore-path",
        ignorePath,
        "--ignore-gitleaks-allow",
        `--log-opts=${options.baseSha}..${options.headSha}`,
        mirrorDir,
      ],
      {
        cwd: path.dirname(configPath),
        env: { PATH: "example-bin", HOME: options.env.home, USER: "agent", LOGNAME: "agent" },
        allowFailure: true,
      },
    );
    expect(mirror.mirrorPath).toHaveBeenCalledExactlyOnceWith("app");
    expect(git.run).toHaveBeenCalledWith(
      ["ls-tree", "-z", options.baseSha, "--", ".gitleaks.toml"],
      { cwd: mirrorDir, allowFailure: true },
    );
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(ignorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(options.scratchDir)).toEqual([]);
  });

  it("copies trusted config and ignore contents only from the base commit in the mirror", async () => {
    const config = "[extend]\nuseDefault = true\n[allowlist]\npaths = ['example.txt']\n";
    const ignore = "# human-reviewed example\nexample-fingerprint\n";
    trustedFiles({ ".gitleaks.toml": config, ".gitleaksignore": ignore });
    const exec = vi.fn<typeof execFileChecked>().mockImplementation(async (_file, args) => {
      const paths = scanArgs(args);
      expect(await readFile(paths.config, "utf8")).toBe(config);
      expect(await readFile(paths.ignore, "utf8")).toBe(ignore);
      return result;
    });
    expect(await scanSecrets(options, { git, mirror, exec })).toEqual({ status: "clean" });
    for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
      expect(git.run).toHaveBeenCalledWith(["show", `${options.baseSha}:${file}`], {
        cwd: mirrorDir,
        allowFailure: true,
      });
    }
  });

  it("blocks publication on findings without returning scanner output", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockResolvedValue({
      ...result,
      code: 42,
      stdout: "redacted findings",
      stderr: "redacted findings",
    });
    expect(await scanSecrets(options, { git, mirror, exec })).toEqual({
      status: "secrets_detected",
    });
    expect(await readdir(options.scratchDir)).toEqual([]);
  });

  it.each([
    { code: 1 },
    { code: 2 },
    { code: 0, timedOut: true },
    { code: null, signal: "SIGTERM" },
    { code: 42, timedOut: true },
  ])("fails closed on scanner errors: %j", async (change) => {
    const exec = vi.fn<typeof execFileChecked>().mockResolvedValue({ ...result, ...change });
    await expect(
      scanSecrets({ ...options, allowMissingForTests: true }, { git, mirror, exec }),
    ).rejects.toThrow(SecretScanError);
    expect(await readdir(options.scratchDir)).toEqual([]);
  });

  function missing() {
    return new ExecError(
      "gitleaks",
      [],
      { ...result, code: null },
      { cause: Object.assign(new Error("unavailable executable"), { code: "ENOENT" }) },
    );
  }

  it("allows an explicit test-only missing-binary skip with a warning and removes private files", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockRejectedValue(missing());
    const warn = vi.fn();
    const scan = await scanSecrets(
      { ...options, allowMissingForTests: true },
      { git, mirror, exec, warn },
    );
    expect(scan).toMatchObject({
      status: "skipped",
      warning: expect.stringContaining("skipped for this test only"),
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(await readdir(options.scratchDir)).toEqual([]);
  });

  it("requires gitleaks in production and does not skip other spawn failures", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockRejectedValue(missing());
    await expect(scanSecrets(options, { git, mirror, exec })).rejects.toThrow(
      "install it before publishing",
    );
    exec.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(
      scanSecrets({ ...options, allowMissingForTests: true }, { git, mirror, exec }),
    ).rejects.toThrow(SecretScanError);
    expect(await readdir(options.scratchDir)).toEqual([]);
  });

  it("rejects untrusted scratch directories, including symlinks back into the worktree", async () => {
    const exec = vi.fn<typeof execFileChecked>();
    const linked = path.join(options.scratchDir, "agent-link");
    await symlink(options.cwd, linked);
    for (const scratchDir of [options.cwd, linked]) {
      await expect(scanSecrets({ ...options, scratchDir }, { git, mirror, exec })).rejects.toThrow(
        "outside the worktree",
      );
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not treat unavailable commits, unreadable trusted files or missing scratch roots as test skips", async () => {
    const exec = vi.fn<typeof execFileChecked>();
    git.run.mockResolvedValue({ code: 128, stdout: "", stderr: "unavailable commit" });
    await expect(
      scanSecrets({ ...options, allowMissingForTests: true }, { git, mirror, exec }),
    ).rejects.toThrow("fetch the base commit first");
    trustedFiles({ ".gitleaks.toml": "trusted" });
    git.run.mockImplementationOnce(async () => ({
      code: 0,
      stdout: `100644 blob ${"c".repeat(40)}\t.gitleaks.toml\0`,
      stderr: "",
    }));
    git.run.mockImplementationOnce(async () => ({ code: 128, stdout: "", stderr: "read failure" }));
    await expect(scanSecrets(options, { git, mirror, exec })).rejects.toThrow(
      "Cannot read trusted",
    );
    await expect(
      scanSecrets(
        {
          ...options,
          scratchDir: path.join(options.scratchDir, "missing"),
          allowMissingForTests: true,
        },
        { git, mirror, exec },
      ),
    ).rejects.toThrow(SecretScanError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects symlinked trusted config rather than treating its link target as config", async () => {
    const exec = vi.fn<typeof execFileChecked>();
    git.run.mockResolvedValue({
      code: 0,
      stdout: `120000 blob ${"c".repeat(40)}\t.gitleaks.toml\0`,
      stderr: "",
    });
    await expect(scanSecrets(options, { git, mirror, exec })).rejects.toThrow(
      "must be a regular file",
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects non-SHA refs and missing or non-directory scan roots without invoking gitleaks", async () => {
    const exec = vi.fn<typeof execFileChecked>();
    await expect(
      scanSecrets({ ...options, baseSha: "HEAD; unsafe" }, { git, mirror, exec }),
    ).rejects.toThrow(SecretScanError);
    await expect(
      scanSecrets(
        { ...options, cwd: path.join(options.cwd, "missing"), allowMissingForTests: true },
        { git, mirror, exec },
      ),
    ).rejects.toThrow(SecretScanError);
    const file = path.join(options.cwd, "example.txt");
    await writeFile(file, "example\n");
    await expect(scanSecrets({ ...options, cwd: file }, { git, mirror, exec })).rejects.toThrow(
      SecretScanError,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.env.SKEP_REAL_GITLEAKS !== "1")(
  "real gitleaks suppression regression",
  () => {
    const git = new NodeGitRunner();
    let root: string;
    let available = false;
    const source = { PATH: process.env.PATH };

    beforeAll(async () => {
      root = await tempDir("real-gitleaks-");
      try {
        await execFileChecked("gitleaks", ["version"], {
          env: typeof source.PATH === "string" ? { PATH: source.PATH } : {},
        });
        available = true;
      } catch (error) {
        if (!missingExecutable(error)) throw error;
      }
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("detects a synthetic key despite a committed catch-all config, ignore file and inline allow comment", async (context) => {
      if (!available) context.skip();
      const writer = path.join(root, "worktree");
      const scratchDir = path.join(root, "daemon");
      await initRepo(writer);
      await mkdir(scratchDir, { mode: 0o700 });
      const baseSha = await commitFile(git, writer, "example.txt", "base\n");
      await commitFile(git, writer, ".gitleaks.toml", "[allowlist]\nregexes = ['.*']\n");
      // Assembled only inside the disposable fixture: an obviously synthetic GitHub-shaped token.
      const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const payload = Array.from(
        { length: 36 },
        (_, index) => alphabet[(index * 17 + 11) % alphabet.length],
      ).join("");
      const fakeKey = ["gh", "p", "_", payload].join("");
      const tokenSha = await commitFile(
        git,
        writer,
        "synthetic-token.txt",
        `const token = "${fakeKey}"; // gitleaks:allow\n`,
      );
      const headSha = await commitFile(
        git,
        writer,
        ".gitleaksignore",
        `${tokenSha}:synthetic-token.txt:github-pat:1\n`,
      );
      const mirror = new CodeMirror({
        git,
        home: path.join(root, "home"),
        worktreeRoot: path.join(root, "worktrees"),
        repos: [{ name: "app", url: writer }],
      });
      await mirror.fetch("app");
      expect(
        await scanSecrets(
          {
            repo: "app",
            cwd: writer,
            baseSha,
            headSha,
            scratchDir,
            env: { home: root, user: "agent", source },
          },
          { git, mirror },
        ),
      ).toEqual({ status: "secrets_detected" });
      expect(await readdir(scratchDir)).toEqual([]);
    });
  },
);
