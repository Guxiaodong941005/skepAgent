import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
import { CheckRunSchema } from "../core/schemas/common.js";
import { NodeGitRunner } from "../git/runner.js";
import { NativeRuntime } from "../runtime/native.js";
import type { ProcessExit, RuntimeBackend, SpawnOptions } from "../runtime/types.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { systemClock } from "../util/clock.js";
import { PathEscapeError } from "../util/fs.js";
import { ChecksError, ChecksRunner, parseCheckCounts } from "./checks.js";
import { EvidenceVerifier } from "./evidence.js";
import { type AttemptKey, Journal } from "./journal.js";
import { CodeMirror } from "./worktree.js";

const attempt: AttemptKey = { task: "T-20261006-abcd", item: "W1", epoch: 1 };
const branch = "skep/T-20261006-abcd/W1/e1";

function checksFile(argv: string[], extra = ""): string {
  return `schema = "skep.checks/v1"\n[checks.unit]\nargv = ${JSON.stringify(argv)}\n${extra}`;
}

describe("trusted checks runner", () => {
  const git = new NodeGitRunner();
  const dirs: string[] = [];
  let root: string;
  let writer: string;
  let mirror: CodeMirror;
  let journal: Journal;
  let worktree: string;
  let baseCommit: string;

  beforeEach(async () => {
    root = await tempDir("trusted-checks-");
    dirs.push(root);
    writer = path.join(root, "writer");
    await initRepo(writer);
    baseCommit = await commitFile(
      git,
      writer,
      ".skep/checks.toml",
      checksFile([
        process.execPath,
        "-e",
        'console.log("trusted base check"); console.error("check stderr")',
      ]),
    );
    mirror = new CodeMirror({
      git,
      home: path.join(root, "home"),
      worktreeRoot: path.join(root, "worktrees"),
      repos: [{ name: "app", url: writer }],
    });
    worktree = (
      await mirror.createWorktree({
        repo: "app",
        baseSha: baseCommit,
        branch,
        path: "attempt",
      })
    ).path;
    journal = new Journal({ roleDir: path.join(root, "role"), clock: systemClock });
  });

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function runner(extra: Partial<ConstructorParameters<typeof ChecksRunner>[0]> = {}) {
    return new ChecksRunner({
      git,
      mirror,
      journal,
      clock: systemClock,
      env: { home: root, user: "agent", source: {} },
      ...extra,
    });
  }

  function options() {
    return { repo: "app", baseCommit, worktree, checks: ["unit"], attempt };
  }

  async function configure(text: string): Promise<void> {
    baseCommit = await commitFile(git, writer, ".skep/checks.toml", text);
    await mirror.fetch("app");
  }

  it("ignores a modified worktree checks file and captures the committed HEAD, log and journal", async () => {
    const head = await commitFile(
      git,
      worktree,
      ".skep/checks.toml",
      checksFile([
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync("untrusted-marker", "ran")',
      ]),
    );
    const run = (await runner().run(options()))[0];
    expect(run).toBeDefined();
    if (!run) throw new Error("Expected a check run");
    expect(CheckRunSchema.parse(run)).toEqual(run);
    expect(run.sha).toBe(head);
    expect(run.sha).not.toBe(baseCommit);
    expect(run.exit).toBe(0);
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    const logPath = path.join(path.dirname(journal.path(attempt)), "checks", `${run.run_id}.log`);
    const log = await readFile(logPath);
    expect(log.toString()).toBe("trusted base check\ncheck stderr\n");
    expect(run.log_sha256).toBe(sha256Hex(log));
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    await expect(stat(path.join(worktree, "untrusted-marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const records = await journal.read(attempt);
    expect(records.map((record) => record.step)).toEqual(["check_started", "check_run", "checks"]);
    expect(records[1]).toMatchObject({
      ...run,
      argv_sha256: sha256Hex(
        canonicalJson([
          process.execPath,
          "-e",
          'console.log("trusted base check"); console.error("check stderr")',
        ]),
      ),
      timed_out: false,
      signal: null,
    });
    expect(records[2]?.run_ids).toEqual([run.run_id]);
    const { duration_ms: _duration, ...evidenceFields } = run;
    expect(
      await new EvidenceVerifier({ git, mirror, journal }).verify(
        {
          id: "ev_check",
          type: "check_run",
          ...evidenceFields,
        },
        attempt,
      ),
    ).toBe(true);
  });

  it("rejects unknown names before starting any command, even when the worktree defines them", async () => {
    await writeFile(
      path.join(worktree, ".skep/checks.toml"),
      checksFile([process.execPath], '[checks.injected]\nargv = ["ignored"]\n'),
    );
    const spawn = vi.fn<RuntimeBackend["spawn"]>();
    await expect(
      runner({ runtime: { name: "native", spawn, isAlive: vi.fn() } }).run({
        ...options(),
        checks: ["unit", "injected"],
      }),
    ).rejects.toThrow("absent from the trusted base-commit");
    expect(spawn).not.toHaveBeenCalled();
    expect(await journal.read(attempt)).toEqual([]);
  });

  it("rejects invalid base refs, unallowlisted repos, missing files and invalid trusted TOML", async () => {
    await expect(runner().load("app", "HEAD")).rejects.toThrow(ChecksError);
    await expect(runner().load("other", baseCommit)).rejects.toThrow("local allowlist");
    const emptyBase = await commitFile(git, writer, "empty.txt", "example\n");
    await git.run(["rm", ".skep/checks.toml"], { cwd: writer });
    const missingBase = await commitFile(git, writer, "empty.txt", "changed\n");
    await mirror.fetch("app");
    await expect(runner().load("app", missingBase)).rejects.toThrow(ChecksError);
    expect(emptyBase).not.toBe(missingBase);
    await configure('schema = "skep.checks/v1"\n[checks.unit]\nargv = "shell string"\n');
    await expect(runner().run(options())).rejects.toThrow("valid checks file");
  });

  it("uses literal argv, a safe cwd, agent identity and sanitized build variables", async () => {
    const literal = "literal; $(printf unexpected) > marker";
    const argv = [process.execPath, "-e", 'console.log("unused")', literal];
    await configure(
      checksFile(
        argv,
        `cwd = "package"\n[checks.unit.env]\nNODE_ENV = "test"\nGIT_ASKPASS = "blocked"\nSSH_AUTH_SOCK = "blocked"\nGH_TOKEN = "blocked"\nOPENAI_API_KEY = "blocked"\nCUSTOM_SECRET = "blocked"\nHOME = "blocked"\n`,
      ),
    );
    await mkdir(path.join(worktree, "package"));
    const clock = new FakeClock(new VirtualTime());
    const spawn = vi.fn<RuntimeBackend["spawn"]>(async (opts) => {
      await writeFile(opts.logPath, "example log\n");
      return {
        pid: 42,
        pgid: 42,
        startToken: "start",
        wait: async () => ({ code: 7, signal: null }),
        signalGroup: vi.fn(),
      };
    });
    const source = {
      PATH: "example-bin",
      GIT_ASKPASS: "blocked",
      SSH_AUTH_SOCK: "blocked",
      GH_TOKEN: "blocked",
      CUSTOM_SECRET: "blocked",
    };
    const run = (
      await runner({
        clock,
        runtime: { name: "native", spawn, isAlive: vi.fn() },
        agentUser: { uid: 42, gid: 42 },
        env: { home: root, user: "agent", source },
      }).run(options())
    )[0];
    expect(run?.exit).toBe(7);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        argv,
        cwd: path.join(worktree, "package"),
        uid: 42,
        gid: 42,
        env: { HOME: root, USER: "agent", LOGNAME: "agent", PATH: "example-bin", NODE_ENV: "test" },
      }),
    );
    expect((source as Record<string, string>).GH_TOKEN).toBe("blocked");
  });

  it("does not follow a check cwd symlink outside the worktree", async () => {
    await configure(checksFile([process.execPath], 'cwd = "escape"\n'));
    await symlink(root, path.join(worktree, "escape"));
    await expect(runner().run(options())).rejects.toThrow(PathEscapeError);
  });

  it("rejects NUL argv and environment values before spawning", async () => {
    await configure(checksFile([process.execPath, "\0"]));
    await expect(runner().run(options())).rejects.toThrow("NUL byte");
    await configure(checksFile([process.execPath], '[checks.unit.env]\nNODE_ENV = "\\u0000"\n'));
    await expect(runner().run(options())).rejects.toThrow("NUL byte");
  });

  it("runs all selected checks with distinct ids, including a failure and parser counts", async () => {
    await configure(
      checksFile(
        [
          process.execPath,
          "-e",
          'console.log("ok 1 - example");console.log("not ok 2 - example");process.exitCode = 1',
        ],
        'parser = "tap"\n[checks.lint]\nargv = ["' +
          process.execPath +
          '", "-e", "process.exitCode = 0"]\n',
      ),
    );
    const runs = await runner().run({ ...options(), checks: ["unit", "lint"] });
    expect(runs.map((run) => [run.check, run.exit])).toEqual([
      ["unit", 1],
      ["lint", 0],
    ]);
    expect(runs[0]).toMatchObject({ passed: 1, failed: 1 });
    expect(new Set(runs.map((run) => run.run_id)).size).toBe(2);
  });

  it("cancels completed deadlines and records virtual timeout as failure even if the leader exited 0", async () => {
    await configure(checksFile([process.execPath], "timeout_sec = 1\n"));
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    let resolveExit: (exit: ProcessExit) => void = () => {};
    const completion = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const signalGroup = vi.fn(() => resolveExit({ code: 0, signal: null }));
    const spawn = vi.fn<RuntimeBackend["spawn"]>(async () => ({
      pid: 42,
      pgid: 42,
      startToken: "start",
      wait: () => completion,
      signalGroup,
    }));
    const pending = runner({ clock, runtime: { name: "native", spawn, isAlive: vi.fn() } }).run(
      options(),
    );
    await expect.poll(() => vt.nextTimerAt()).toBe(1000);
    await vt.advance(1000);
    const [run] = await pending;
    expect(signalGroup).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(run).toMatchObject({ exit: 124, duration_ms: 1000 });
    expect((await journal.read(attempt))[1]).toMatchObject({ timed_out: true });
    expect(vt.nextTimerAt()).toBeNull();
    const fastSpawn = vi.fn<RuntimeBackend["spawn"]>(async () => ({
      pid: 43,
      pgid: 43,
      startToken: "start",
      wait: async () => ({ code: 0, signal: null }),
      signalGroup,
    }));
    await runner({ clock, runtime: { name: "native", spawn: fastSpawn, isAlive: vi.fn() } }).run(
      options(),
    );
    expect(vt.nextTimerAt()).toBeNull();
    expect(signalGroup).toHaveBeenCalledTimes(1);
  });

  it("kills a launched check if recording its start fails", async () => {
    const signalGroup = vi.fn();
    const wait = vi.fn(async () => ({ code: null, signal: "SIGKILL" }));
    const spawn = vi.fn<RuntimeBackend["spawn"]>(async () => ({
      pid: 42,
      pgid: 42,
      startToken: "start",
      wait,
      signalGroup,
    }));
    await expect(
      runner({
        runtime: { name: "native", spawn, isAlive: vi.fn() },
        journal: {
          path: journal.path.bind(journal),
          append: vi.fn().mockRejectedValue(new Error("disk full")),
        },
      }).run(options()),
    ).rejects.toThrow("process group was stopped");
    expect(signalGroup).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(wait).toHaveBeenCalledOnce();
  });

  it.skipIf(!["linux", "darwin"].includes(platform()))(
    "kills native grandchildren after a timeout, including when the leader has already exited",
    async () => {
      const dir = await mkdtemp(path.join(root, "tree-"));
      const script = path.join(dir, "tree.cjs");
      await writeFile(
        script,
        `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      if (process.argv[2] === "child") {
        process.on("SIGTERM", () => {});
        writeFileSync(process.argv[3], String(process.pid));
        setInterval(() => {}, 1000);
      } else {
        spawn(process.execPath, [__filename, "child", process.argv[2]], { env: {}, shell: false, stdio: "ignore" }).unref();
      }
    `,
      );
      const pidPath = path.join(dir, "child-pid");
      await configure(checksFile([process.execPath, script, pidPath], "timeout_sec = 1\n"));
      const vt = new VirtualTime();
      const clock = new FakeClock(vt);
      const native = new NativeRuntime();
      let handle: Awaited<ReturnType<RuntimeBackend["spawn"]>> | undefined;
      const runtime: RuntimeBackend = {
        name: "native",
        isAlive: native.isAlive.bind(native),
        spawn: async (opts: SpawnOptions) => {
          handle = await native.spawn(opts);
          return handle;
        },
      };
      const pending = runner({ clock, runtime }).run(options());
      try {
        await expect
          .poll(async () => {
            try {
              return Number(await readFile(pidPath, "utf8"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
              throw error;
            }
          })
          .toBeGreaterThan(0);
        const childPid = Number(await readFile(pidPath, "utf8"));
        await expect.poll(() => vt.nextTimerAt()).toBe(1000);
        await expect
          .poll(async () => {
            if (!handle) return true;
            return native.isAlive(handle.pgid, handle.startToken);
          })
          .toBe(false);
        await vt.advance(1000);
        expect((await pending)[0]?.exit).toBe(124);
        if (platform() === "linux") {
          let state = "gone";
          try {
            const text = await readFile(`/proc/${childPid}/stat`, "utf8");
            state =
              text
                .slice(text.lastIndexOf(")") + 1)
                .trim()
                .split(/\s+/)[0] ?? "";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          expect(["gone", "Z", "X"]).toContain(state);
        }
        expect(vt.nextTimerAt()).toBeNull();
      } finally {
        handle?.signalGroup("SIGKILL");
        await pending;
      }
    },
  );
});

describe("optional trusted check count parsers", () => {
  it.each([
    { parser: "none" as const, log: "not test output", counts: {} },
    {
      parser: "tap" as const,
      log: "TAP version 13\nok 1\n    not ok 1 - nested\nnot ok 2\nnot ok 3 # TODO later\n1..3\n",
      counts: { passed: 2, failed: 1 },
    },
    {
      parser: "junit" as const,
      log: '<testsuites><testsuite tests="5" failures="1" errors="1" skipped="1"/><testsuite tests="2"/></testsuites>',
      counts: { passed: 4, failed: 2 },
    },
    {
      parser: "vitest-json" as const,
      log: '{"numPassedTests":4,"numFailedTests":2,"extra":true}',
      counts: { passed: 4, failed: 2 },
    },
  ])("parses $parser metadata", ({ parser, log, counts }) => {
    expect(parseCheckCounts(log, parser)).toEqual(counts);
  });

  it.each([
    { parser: "vitest-json" as const, log: "invalid json" },
    { parser: "vitest-json" as const, log: '{"numPassedTests":-1,"numFailedTests":2}' },
    { parser: "tap" as const, log: "no test points" },
    { parser: "junit" as const, log: '<testsuite failures="1"/>' },
    { parser: "junit" as const, log: '<testsuite tests="1" failures="2"/>' },
  ])("does not invent counts from malformed $parser output", ({ parser, log }) => {
    expect(parseCheckCounts(log, parser)).toEqual({});
  });
});
