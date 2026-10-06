import { ChildProcess, type ExecFileException, execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInterruptLadder } from "../exec/interrupt.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { systemClock } from "../util/clock.js";
import { execFileChecked } from "../util/exec.js";
import { NativeRuntime, NativeRuntimeError, readStartToken } from "./native.js";
import type { ProcessHandle, SpawnOptions } from "./types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function psResult(stdout: string, stderr = "", error: ExecFileException | null = null): void {
  vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, callback) => {
    callback?.(error, stdout, stderr);
    return new ChildProcess();
  });
}

describe("readStartToken", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("reads Linux field 22 despite spaces, parentheses and newlines in comm", async () => {
    vi.mocked(platform).mockReturnValueOnce("linux");
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "S";
    fields[19] = "12345678901234567890";
    vi.mocked(readFile).mockResolvedValueOnce(`42 (mac (worker)\n)) ${fields.join(" ")}\n`);

    expect(await readStartToken(42)).toBe("12345678901234567890");
    expect(readFile).toHaveBeenCalledWith("/proc/42/stat", "utf8");
  });

  it("returns null for a process that has disappeared", async () => {
    vi.mocked(platform).mockReturnValueOnce("linux");
    vi.mocked(readFile).mockRejectedValueOnce(errno("ENOENT"));
    expect(await readStartToken(42)).toBeNull();
  });

  it("handles a process disappearing after its proc file was opened", async () => {
    vi.mocked(platform).mockReturnValueOnce("linux");
    vi.mocked(readFile).mockResolvedValueOnce("");
    expect(await readStartToken(42)).toBeNull();
  });

  it("reports permission errors instead of treating unreadable metadata as a dead process", async () => {
    vi.mocked(platform).mockReturnValueOnce("linux");
    vi.mocked(readFile).mockRejectedValueOnce(errno("EACCES"));
    await expect(readStartToken(42)).rejects.toMatchObject({
      name: "NativeRuntimeError",
      message: "Cannot read /proc/42/stat for the start token",
      cause: { code: "EACCES" },
    });
  });

  it.each(["42 (mac) S 1", "42 mac S 1", "43 (mac) S 1", "42 (mac) S 1 garbage"])(
    "rejects malformed process metadata: %s",
    async (text) => {
      vi.mocked(platform).mockReturnValueOnce("linux");
      vi.mocked(readFile).mockResolvedValueOnce(text);
      await expect(readStartToken(42)).rejects.toThrow(NativeRuntimeError);
    },
  );

  it("uses ps lstart on macOS with a fixed locale, timezone and no shell", async () => {
    vi.mocked(platform).mockReturnValueOnce("darwin");
    psResult("  Mon Oct  5 09:14:03 2026\n");
    expect(await readStartToken(42)).toBe("Mon Oct 5 09:14:03 2026");
    expect(execFile).toHaveBeenCalledWith(
      "/bin/ps",
      ["-o", "lstart=", "-p", "42"],
      { shell: false, env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("returns null when macOS ps finds no matching process", async () => {
    vi.mocked(platform).mockReturnValueOnce("darwin");
    psResult("", "", Object.assign(new Error("No process"), { code: 1 }));
    expect(await readStartToken(42)).toBeNull();
  });

  it("reports ps execution failures and malformed output", async () => {
    vi.mocked(platform).mockReturnValue("darwin");
    psResult("", "Permission denied", Object.assign(new Error("ps failed"), { code: 1 }));
    await expect(readStartToken(42)).rejects.toThrow("Cannot read the start token");
    psResult("unexpected process output");
    await expect(readStartToken(42)).rejects.toThrow("Malformed ps start time");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an unsafe process id %s without reading or signalling",
    async (pid) => {
      const kill = vi.spyOn(process, "kill");
      await expect(readStartToken(pid)).rejects.toThrow(NativeRuntimeError);
      await expect(new NativeRuntime().isAlive(pid, "1234")).rejects.toThrow(NativeRuntimeError);
      expect(readFile).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported operating systems", async () => {
    vi.mocked(platform).mockReturnValue("win32");
    await expect(readStartToken(42)).rejects.toThrow("requires Linux or macOS");
  });
});

// All live subprocesses stay on the local machine with empty or explicitly listed environments.
describe.skipIf(!["linux", "darwin"].includes(platform()))("NativeRuntime", () => {
  const dirs: string[] = [];
  const handles: ProcessHandle[] = [];
  const runtime = new NativeRuntime();

  afterEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) {
      handle.signalGroup("SIGKILL");
      await handle.wait();
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function options(argv: SpawnOptions["argv"]): Promise<SpawnOptions> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "skep-native-")));
    dirs.push(dir);
    return { argv, cwd: dir, env: {}, logPath: path.join(dir, "runtime.log") };
  }

  async function start(opts: SpawnOptions): Promise<ProcessHandle> {
    const handle = await runtime.spawn(opts);
    handles.push(handle);
    return handle;
  }

  async function idle(): Promise<ProcessHandle> {
    return start(await options([process.execPath, "-e", "setInterval(() => {}, 1000)"]));
  }

  it("spawns a detached group, forwards literal argv/stdin/cwd/env and combines both output streams", async () => {
    const arg = "literal; $(printf unexpected) > marker";
    const opts = await options([
      process.execPath,
      "-e",
      `(() => {
        const stdin = require("node:fs").readFileSync(0, "utf8");
        console.log(JSON.stringify({ stdin, cwd: process.cwd(), env: process.env, arg: process.argv[1] }));
        console.error("stderr line");
        process.exitCode = 7;
      })();`,
      arg,
    ]);
    opts.env = { SKEP_DEVICE: "mac" };
    opts.stdin = "example prompt\n";
    await writeFile(opts.logPath, "earlier log\n");

    const handle = await start(opts);
    expect(runtime.name).toBe("native");
    expect(handle.pgid).toBe(handle.pid);
    expect(handle.startToken).not.toBe("");
    expect(await handle.wait()).toEqual({ code: 7, signal: null });
    expect(await handle.wait()).toEqual({ code: 7, signal: null });
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
    const lines = (await readFile(opts.logPath, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("earlier log");
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      stdin: opts.stdin,
      cwd: opts.cwd,
      env: opts.env,
      arg,
    });
    expect(lines[2]).toBe("stderr line");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      opts.argv.slice(1),
      expect.objectContaining({ detached: true, shell: false, cwd: opts.cwd, env: opts.env }),
    );
    const stdio = vi.mocked(spawn).mock.calls[0]?.[2]?.stdio;
    expect(stdio).toEqual(["pipe", expect.any(Number), expect.any(Number)]);
    if (!Array.isArray(stdio)) throw new Error("Expected file-descriptor stdio");
    expect(stdio[1]).toBe(stdio[2]);
    await expect(stat(path.join(opts.cwd, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes stdin without a prompt and creates a private log, releasing the parent's descriptor", async () => {
    const opts = await options([
      process.execPath,
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(0))",
    ]);
    const handle = await start(opts);
    expect(await handle.wait()).toEqual({ code: 0, signal: null });
    expect(await readFile(opts.logPath, "utf8")).toBe("");
    expect((await stat(opts.logPath)).mode & 0o777).toBe(0o600);
    const file = await vi.mocked(open).mock.results[0]?.value;
    if (!file) throw new Error("Expected an opened runtime log");
    await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("supports fast exits even when the OS has already removed the start token", async () => {
    for (let i = 0; i < 8; i++) {
      const handle = await start(await options(["/usr/bin/true"]));
      expect(await handle.wait()).toEqual({ code: 0, signal: null });
      expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
      const vt = new VirtualTime();
      expect(await runInterruptLadder(handle, new FakeClock(vt))).toBe("completed");
      expect(vt.nextTimerAt()).toBeNull();
    }
  });

  it("guards PID reuse by comparing the recorded start token before inspecting the group", async () => {
    const handle = await idle();
    expect(await readStartToken(handle.pid)).toBe(handle.startToken);
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(true);
    const kill = vi.spyOn(process, "kill");
    expect(await runtime.isAlive(handle.pgid, `${handle.startToken}-wrong`)).toBe(false);
    expect(await runtime.isAlive(handle.pgid, "")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    handle.signalGroup("SIGTERM");
    expect(await handle.wait()).toEqual({ code: null, signal: "SIGTERM" });
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
  });

  it("treats a matching but unsignalable group as live and surfaces unexpected inspection failures", async () => {
    const handle = await idle();
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw errno("EPERM");
    });
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(true);
    kill.mockImplementationOnce(() => {
      throw errno("ESRCH");
    });
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
    kill.mockImplementationOnce(() => {
      throw errno("EINVAL");
    });
    await expect(runtime.isAlive(handle.pgid, handle.startToken)).rejects.toThrow(
      NativeRuntimeError,
    );
  });

  it("ignores signals to an exited group and reports real signal failures", async () => {
    const handle = await idle();
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw errno("EPERM");
    });
    expect(() => handle.signalGroup("SIGINT")).toThrow("Cannot send SIGINT");
    handle.signalGroup("SIGKILL");
    expect(await handle.wait()).toEqual({ code: null, signal: "SIGKILL" });
    expect(() => handle.signalGroup("SIGTERM")).not.toThrow();
  });

  it("reports spawn and log-open failures and still releases the parent's log descriptor", async () => {
    const opts = await options(["/example.invalid/missing-command"]);
    await expect(runtime.spawn(opts)).rejects.toThrow("Cannot spawn");
    const file = await vi.mocked(open).mock.results[0]?.value;
    if (!file) throw new Error("Expected an opened runtime log");
    await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
    await expect(runtime.spawn({ ...opts, logPath: opts.cwd })).rejects.toThrow(
      "Cannot open runtime log",
    );
  });

  it.skipIf(platform() !== "linux")(
    "kills the detached child if reading its token fails",
    async () => {
      const opts = await options([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
      vi.mocked(readFile).mockRejectedValueOnce(errno("EACCES"));
      await expect(runtime.spawn(opts)).rejects.toThrow("Cannot read /proc/");
      const child = vi.mocked(spawn).mock.results[0]?.value;
      expect(child?.signalCode).toBe("SIGKILL");
    },
  );

  it.skipIf(platform() !== "linux")(
    "fails closed when a live child has no start token",
    async () => {
      const opts = await options([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
      vi.mocked(readFile).mockRejectedValueOnce(errno("ENOENT"));
      await expect(runtime.spawn(opts)).rejects.toThrow("has no readable start token");
      const child = vi.mocked(spawn).mock.results[0]?.value;
      expect(child?.signalCode).toBe("SIGKILL");
    },
  );

  it.skipIf(typeof process.getuid !== "function" || process.getuid() !== 0)(
    "runs as the requested uid and gid when the daemon is root",
    async () => {
      const opts = await options([
        process.execPath,
        "-e",
        "console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid() }))",
      ]);
      await chmod(opts.cwd, 0o755);
      // Root in a user namespace may have only uid/gid 0 mapped. Exercise real OS options
      // with an available id there, and a distinct unprivileged id on a normally mapped host.
      const mappedId = async (file: string): Promise<number> => {
        if (platform() !== "linux") return 65_534;
        const mappings = (await readFile(file, "utf8")).trim().split("\n");
        const available = mappings.some((line) => {
          const [first = 0, , count = 0] = line.trim().split(/\s+/).map(Number);
          return first <= 65_534 && 65_534 < first + count;
        });
        return available ? 65_534 : 0;
      };
      opts.uid = await mappedId("/proc/self/uid_map");
      opts.gid = await mappedId("/proc/self/gid_map");
      const handle = await start(opts);
      expect(await handle.wait()).toEqual({ code: 0, signal: null });
      expect(JSON.parse(await readFile(opts.logPath, "utf8"))).toEqual({
        uid: opts.uid,
        gid: opts.gid,
      });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        opts.argv.slice(1),
        expect.objectContaining({ uid: opts.uid, gid: opts.gid }),
      );
    },
  );

  async function macGroup(leaderGone = false): Promise<{
    handle: ProcessHandle;
    child: ChildProcess;
    vt: VirtualTime;
  }> {
    const vt = new VirtualTime();
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 42 });
    vi.mocked(platform).mockReturnValue("darwin");
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockImplementationOnce(() => {
      setImmediate(() => child.emit("spawn"));
      return child;
    });
    if (leaderGone) {
      vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, callback) => {
        Object.defineProperty(child, "exitCode", { value: 0 });
        child.emit("exit", 0, null);
        callback?.(null, "", "");
        return new ChildProcess();
      });
      psResult("42 S+\n");
    } else {
      psResult("Mon Oct 5 09:14:03 2026\n");
    }
    const handle = await new NativeRuntime({ clock: new FakeClock(vt) }).spawn(
      await options([process.execPath]),
    );
    return { handle, child, vt };
  }

  it("returns a handle for surviving children when the leader exits before its token is read", async () => {
    const { handle, vt } = await macGroup(true);
    expect(handle.startToken).toBe("");
    expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
    let done = false;
    const wait = handle.wait().then((exit) => {
      done = true;
      return exit;
    });
    expect(done).toBe(false);
    expect(vt.nextTimerAt()).toBe(25);
    handle.signalGroup("SIGKILL");
    expect(process.kill).toHaveBeenLastCalledWith(-42, "SIGKILL");
    psResult("42 Z\n");
    await vt.advance(25);
    expect(await wait).toEqual({ code: 0, signal: null });
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("waits on macOS group status with the injected clock and ignores dead zombies", async () => {
    const { handle, child, vt } = await macGroup();
    let done = false;
    const wait = handle.wait().then((exit) => {
      done = true;
      return exit;
    });
    psResult(" 42 S+\n 99 R\n");
    child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    expect(vt.nextTimerAt()).toBe(25);
    psResult(" 42 Z\n 99 R\n");
    await vt.advance(25);
    expect(await wait).toEqual({ code: 0, signal: null });
    expect(vt.nextTimerAt()).toBeNull();
    expect(execFile).toHaveBeenLastCalledWith(
      "/bin/ps",
      ["-axo", "pgid=,stat="],
      { shell: false, env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it.each(["malformed", "execution"])(
    "reports %s failures in macOS group supervision",
    async (kind) => {
      const { handle, child, vt } = await macGroup();
      if (kind === "malformed") psResult("unexpected process status");
      else psResult("", "ps failed", Object.assign(new Error("ps failed"), { code: 1 }));
      child.emit("exit", 0, null);
      await expect(handle.wait()).rejects.toThrow(NativeRuntimeError);
      expect(vt.nextTimerAt()).toBeNull();
    },
  );

  const treeScript = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const path = require("node:path");
    const dir = process.argv[2];
    const depth = Number(process.argv[3]);
    const mode = process.argv[4];
    const leaderExits = process.argv[5] === "exit";
    let child;
    process.on("SIGINT", () => {
      writeFileSync(path.join(dir, "int-" + depth), "received");
      if (depth === 0 && leaderExits) process.exit(0);
    });
    process.on("SIGTERM", () => {
      writeFileSync(path.join(dir, "term-" + depth), "received");
      if (mode === "kill") return;
      if (!child || child.exitCode !== null || child.signalCode !== null) process.exit(0);
      child.once("exit", () => process.exit(0));
    });
    writeFileSync(path.join(dir, "pid-" + depth), String(process.pid));
    if (depth < 2) {
      child = spawn(process.execPath, [process.argv[1], dir, String(depth + 1), mode, process.argv[5]], {
        shell: false, env: {}, stdio: "ignore"
      });
    } else {
      writeFileSync(path.join(dir, "ready"), "ready");
    }
    setInterval(() => {}, 1000);
  `;

  async function exists(file: string): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function running(pid: number): Promise<boolean> {
    if (platform() === "linux") {
      let text: string;
      try {
        text = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      // SIGKILL can orphan zombies until the host's init reaps them; they are already dead.
      return !["Z", "X"].includes(
        text
          .slice(text.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/)[0] ?? "",
      );
    }
    const result = await execFileChecked("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      env: { LC_ALL: "C" },
      allowFailure: true,
    });
    return result.code === 0 && !result.stdout.trim().startsWith("Z");
  }

  it.each([
    { mode: "term", leaderExits: false },
    { mode: "kill", leaderExits: false },
    { mode: "term", leaderExits: true },
    { mode: "kill", leaderExits: true },
  ])(
    "stops INT-trapping grandchildren via $mode even when leaderExits=$leaderExits",
    async ({ mode, leaderExits }) => {
      const opts = await options([process.execPath]);
      const script = path.join(opts.cwd, "tree.cjs");
      await writeFile(script, treeScript);
      opts.argv = [process.execPath, script, opts.cwd, "0", mode, leaderExits ? "exit" : "stay"];
      const handle = await start(opts);
      await expect.poll(() => exists(path.join(opts.cwd, "ready"))).toBe(true);
      const pids = await Promise.all(
        [0, 1, 2].map(async (depth) =>
          Number(await readFile(path.join(opts.cwd, `pid-${depth}`), "utf8")),
        ),
      );
      expect(pids[0]).toBe(handle.pid);
      for (const pid of pids) expect(await running(pid)).toBe(true);
      const vt = new VirtualTime();
      const clock = new FakeClock(vt);
      const result = runInterruptLadder(handle, clock);
      for (const depth of [0, 1, 2]) {
        await expect.poll(() => exists(path.join(opts.cwd, `int-${depth}`))).toBe(true);
      }
      if (leaderExits) {
        const leader = vi.mocked(spawn).mock.results[0]?.value;
        await expect.poll(() => leader?.exitCode).toBe(0);
      }
      await vt.advance(120_000);
      if (mode === "kill") {
        for (const depth of leaderExits ? [1, 2] : [0, 1, 2]) {
          await expect.poll(() => exists(path.join(opts.cwd, `term-${depth}`))).toBe(true);
        }
        await vt.advance(30_000);
      }
      expect(await result).toBe(mode === "kill" ? "killed" : "interrupted");
      expect(await handle.wait()).toEqual(
        mode === "kill" && !leaderExits
          ? { code: null, signal: "SIGKILL" }
          : { code: 0, signal: null },
      );
      // I/O completion is real; only the protocol's 120 s / 30 s waits are virtual.
      for (const pid of pids) {
        for (let tries = 0; tries < 100 && (await running(pid)); tries++)
          await systemClock.sleep(10);
        expect(await running(pid)).toBe(false);
      }
      expect(await runtime.isAlive(handle.pgid, handle.startToken)).toBe(false);
      expect(vt.nextTimerAt()).toBeNull();
    },
  );
});
