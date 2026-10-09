import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { systemClock } from "../util/clock.js";
import {
  createPtyRunner,
  type PtyRunOptions,
  PtyUnavailableError,
  stripTerminalControls,
} from "./pty.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return { ...actual, fileURLToPath: vi.fn(actual.fileURLToPath) };
});

describe("stripTerminalControls", () => {
  it.each([
    ["\x1b[31mExample\x1b[0m", "Example"],
    ["a\x1b[?25lb\x1b[2Kc", "abc"],
    ["a\x9b31mb\x9b0m", "ab"],
    ["a\x1b]0;Example title\x07b", "ab"],
    ["a\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\b", "alinkb"],
    ["a\x9dExample title\x9cb", "ab"],
    ["a\x1bPExample\nDCS\x1b\\b", "ab"],
    ["a\x90Example\x9cb", "ab"],
    ["a\r\nb\r\nc", "a\nb\nc"],
    ["X\bY _\bZ", "Y Z"],
    ["\b\bExample\n\btext", "Example\ntext"],
    ["é\b例🙂\b!", "例!"],
    ["a\x1b]truncated OSC", "a"],
    ["a\x1bPtruncated DCS", "a"],
    ["a\x1b[31", "a"],
  ])("strips terminal sequences from %j", (input, expected) => {
    expect(stripTerminalControls(input)).toBe(expected);
  });
});

describe("PTY runner", () => {
  let helperDir: string;
  let helperPath: string;
  let dir: string;
  let opts: PtyRunOptions;
  const liveGroups = new Set<number>();

  beforeAll(async () => {
    helperDir = await mkdtemp(join(tmpdir(), "skep-pty-helper-"));
    helperPath = join(helperDir, "pty-helper.js");
    const source = await readFile(new URL("./pty-helper.ts", import.meta.url), "utf8");
    await writeFile(
      helperPath,
      transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
      }).outputText,
    );
    await symlink(join(process.cwd(), "node_modules"), join(helperDir, "node_modules"), "dir");
  });
  afterAll(async () => {
    await rm(helperDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const actualProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const actualUrl = await vi.importActual<typeof import("node:url")>("node:url");
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation((file, argv, options) => {
        const child = actualProcess.spawn(file, argv, options);
        if (child.pid) liveGroups.add(child.pid);
        return child;
      });
    vi.mocked(fileURLToPath)
      .mockReset()
      .mockImplementation((url) => {
        if (String(url).endsWith("/pty-helper.js")) return helperPath;
        return actualUrl.fileURLToPath(url);
      });
    dir = await mkdtemp(join(tmpdir(), "skep-pty-"));
    opts = {
      argv: [process.execPath, "-e", "process.stdout.write('Example output'); process.exit(7)"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", TERM: "dumb" },
      transcriptPath: join(dir, "transcript"),
      input: "",
      clock: systemClock,
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    liveGroups.clear();
    await rm(dir, { recursive: true, force: true });
  });

  function fakeChild(): ChildProcess {
    const child = new ChildProcess();
    Object.assign(child, {
      pid: 4101,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child);
    return child;
  }
  async function spawned(): Promise<NodeJS.ProcessEnv> {
    await expect.poll(() => vi.mocked(spawn).mock.calls.length).toBe(1);
    const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
    if (!env?.SKEP_PTY_PIDFILE) throw new Error("Missing helper environment");
    return env;
  }
  async function record(body: Buffer = Buffer.from("Example raw output")): Promise<void> {
    await writeFile(
      opts.transcriptPath,
      Buffer.concat([
        Buffer.from("Script started on example [COMMAND=example]\n"),
        body,
        Buffer.from("\nScript done on example [COMMAND_EXIT_CODE=0]\n"),
      ]),
    );
  }

  it("runs a real Linux PTY and propagates exit 7 with a private transcript", async () => {
    const output = await createPtyRunner().run(opts);
    expect(output.exit).toEqual({ code: 7, signal: null });
    expect(output.aborted).toBe(false);
    expect(output.transcript.toString()).toBe("Example output");
    expect(await readFile(opts.transcriptPath)).toEqual(output.transcript);
    expect((await stat(opts.transcriptPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["transcript"]);
  });

  it("gives the agent a terminal and preserves hostile-looking argv without a shell", async () => {
    const argument = "spaces 'quotes'; $(example) `example`\nsecond line";
    opts.argv = [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({tty:!!process.stdin.isTTY,arg:process.argv[1],env:process.env.EXAMPLE,helper:process.env.SKEP_PTY_ARGV??null}))",
      argument,
    ];
    opts.env.EXAMPLE = "example-local-value";
    const output = await createPtyRunner().run(opts);
    expect(JSON.parse(output.transcript.toString())).toEqual({
      tty: true,
      arg: argument,
      env: opts.env.EXAMPLE,
      helper: null,
    });
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call?.[1]).toEqual([
      "-q",
      "-e",
      "-f",
      "-c",
      'exec "$SKEP_PTY_NODE" "$SKEP_PTY_HELPER"',
      opts.transcriptPath,
    ]);
    expect(call?.[2]).toMatchObject({ shell: false, detached: true, stdio: "pipe", cwd: dir });
    expect(call?.[2]?.env?.SKEP_PTY_ARGV).toBe(JSON.stringify(opts.argv));
  });

  it("writes test input and closes stdin", async () => {
    opts.input = "Example input\n";
    opts.argv = [
      process.execPath,
      "-e",
      "process.stdin.once('data',data=>{process.stdout.write('RECEIVED:'+data);process.exit(0)})",
    ];
    const output = await createPtyRunner().run(opts);
    expect(output.exit.code).toBe(0);
    expect(output.transcript.toString()).toContain("RECEIVED:Example input\r\n");
  });

  it("maps an agent signal to 128 plus its signal number", async () => {
    opts.argv = [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"];
    expect((await createPtyRunner().run(opts)).exit).toEqual({ code: 143, signal: null });
  });

  it.each(["linux", "darwin"] as const)("inherits the human terminal on %s", async (platform) => {
    const child = fakeChild();
    opts.input = "inherit";
    const run = createPtyRunner({ platform, scriptPath: "example-script" }).run(opts);
    const env = await spawned();
    await writeFile(env.SKEP_PTY_PIDFILE ?? "", "5101\n");
    await record();
    child.emit("close", 0, null);
    expect((await run).exit.code).toBe(0);
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("example-script");
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      stdio: "inherit",
      shell: false,
      detached: true,
    });
    if (platform === "darwin")
      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
        "-q",
        opts.transcriptPath,
        process.execPath,
        helperPath,
      ]);
  });

  it("keeps raw non-UTF-8 bytes and internal framing-like lines", async () => {
    const child = fakeChild();
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\x1b[31mExample\x1b[0m\r\nScript done on interior\r\n"),
    ]);
    const run = createPtyRunner().run(opts);
    const env = await spawned();
    await writeFile(env.SKEP_PTY_PIDFILE ?? "", "5101\n");
    await record(body);
    child.emit("close", 0, null);
    expect((await run).transcript).toEqual(body);
    expect(await readFile(opts.transcriptPath)).toEqual(body);
  });

  it("uses SIGTERM then SIGKILL on both groups with the injected clock", async () => {
    const child = fakeChild();
    const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -4101 && signal === "SIGKILL") child.emit("close", null, "SIGKILL");
      return true;
    });
    const vt = new VirtualTime();
    opts.clock = new FakeClock(vt);
    opts.graceMs = 25;
    const abort = new AbortController();
    opts.signal = abort.signal;
    const run = createPtyRunner().run(opts);
    const env = await spawned();
    await writeFile(env.SKEP_PTY_PIDFILE ?? "", "5101\n");
    await record();
    abort.abort();
    await expect
      .poll(() => signals.mock.calls.some(([pid, signal]) => pid === -5101 && signal === "SIGTERM"))
      .toBe(true);
    expect(signals).toHaveBeenCalledWith(-4101, "SIGTERM");
    await vt.advance(24);
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    await vt.advance(1);
    const output = await run;
    expect(output).toMatchObject({ aborted: true, exit: { code: null, signal: "SIGKILL" } });
    expect(signals).toHaveBeenCalledWith(-5101, "SIGKILL");
    expect(signals).toHaveBeenCalledWith(-4101, "SIGKILL");
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGINT")).toBe(false);
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("keeps supervising descendants after script exits and uses the default 10 s grace", async () => {
    const child = fakeChild();
    const signals = vi.spyOn(process, "kill").mockReturnValue(true);
    const vt = new VirtualTime();
    opts.clock = new FakeClock(vt);
    const abort = new AbortController();
    opts.signal = abort.signal;
    const run = createPtyRunner().run(opts);
    const env = await spawned();
    abort.abort();
    await writeFile(env.SKEP_PTY_PIDFILE ?? "", "5101\n");
    await record();
    child.emit("close", 0, null);
    await expect
      .poll(() => signals.mock.calls.some(([pid, signal]) => pid === -5101 && signal === "SIGTERM"))
      .toBe(true);
    await vt.advance(9999);
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    await vt.advance(1);
    expect((await run).aborted).toBe(true);
    expect(signals).toHaveBeenCalledWith(-5101, "SIGKILL");
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("cancels the grace timer when both process groups finish", async () => {
    const child = fakeChild();
    const vt = new VirtualTime();
    opts.clock = new FakeClock(vt);
    const abort = new AbortController();
    opts.signal = abort.signal;
    const signals = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("finished"), { code: "ESRCH" });
      return true;
    });
    const run = createPtyRunner().run(opts);
    const env = await spawned();
    await writeFile(env.SKEP_PTY_PIDFILE ?? "", "5101\n");
    await record();
    abort.abort();
    child.emit("close", 0, null);
    expect((await run).aborted).toBe(true);
    expect(vt.nextTimerAt()).toBeNull();
    expect(signals).toHaveBeenCalledWith(-5101, "SIGTERM");
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });

  it("aborts a real PTY group that traps SIGTERM", async () => {
    const abort = new AbortController();
    const vt = new VirtualTime();
    opts.clock = new FakeClock(vt);
    opts.signal = abort.signal;
    opts.graceMs = 20;
    opts.argv = [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('ready',String(process.pid));process.on('SIGTERM',()=>require('node:fs').writeFileSync('term','seen'));setInterval(()=>{},1000)",
    ];
    const run = createPtyRunner().run(opts);
    await expect.poll(async () => (await readdir(dir)).includes("ready")).toBe(true);
    const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
    const helperPid = Number(await readFile(env?.SKEP_PTY_PIDFILE ?? "", "utf8"));
    liveGroups.add(helperPid);
    abort.abort();
    await expect.poll(async () => (await readdir(dir)).includes("term")).toBe(true);
    await vt.advance(20);
    expect((await run).aborted).toBe(true);
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("reports a missing script as PtyUnavailableError and removes its sidecar", async () => {
    await expect(
      createPtyRunner({ scriptPath: join(dir, "missing-script") }).run(opts),
    ).rejects.toBeInstanceOf(PtyUnavailableError);
    expect(await readdir(dir)).toEqual(["transcript"]);
  });

  it("reports a missing compiled helper before invoking an agent", async () => {
    vi.mocked(fileURLToPath).mockReturnValueOnce(join(dir, "missing-helper.js"));
    await expect(createPtyRunner().run(opts)).rejects.toBeInstanceOf(PtyUnavailableError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cleans up after synchronous script startup failures", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("Example spawn failure");
    });
    await expect(createPtyRunner().run(opts)).rejects.toBeInstanceOf(PtyUnavailableError);
    expect(await readdir(dir)).toEqual(["transcript"]);
  });

  it("tightens an existing transcript's permissions", async () => {
    await writeFile(opts.transcriptPath, "previous transcript", { mode: 0o644 });
    const output = await createPtyRunner().run(opts);
    expect(output.transcript.toString()).toBe("Example output");
    expect((await stat(opts.transcriptPath)).mode & 0o777).toBe(0o600);
  });

  it("reports local transcript preparation failures as typed errors", async () => {
    opts.transcriptPath = join(dir, "missing-directory", "transcript");
    await expect(createPtyRunner().run(opts)).rejects.toMatchObject({
      name: "PtyRunError",
      message: expect.stringContaining("transcript"),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a helper that cannot initialize", async () => {
    opts.argv = [] as unknown as [string, ...string[]];
    await expect(createPtyRunner().run(opts)).rejects.toBeInstanceOf(PtyUnavailableError);
  });

  it("does not start a process for an already aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    opts.signal = abort.signal;
    expect(await createPtyRunner().run(opts)).toMatchObject({
      aborted: true,
      exit: { code: null, signal: null },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    "validates the injected-clock grace %s",
    async (graceMs) => {
      opts.graceMs = graceMs;
      await expect(createPtyRunner().run(opts)).rejects.toBeInstanceOf(RangeError);
    },
  );

  it("rejects unsupported platforms", async () => {
    await expect(createPtyRunner({ platform: "win32" }).run(opts)).rejects.toBeInstanceOf(
      PtyUnavailableError,
    );
  });
});
