import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyHelperError, runPtyHelper } from "./pty-helper.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

describe("PTY helper", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let child: ChildProcess;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skep-pty-helper-test-"));
    env = {
      SKEP_PTY_ARGV: JSON.stringify(["example-agent", "spaces; $(example)", "line\nbreak"]),
      SKEP_PTY_PIDFILE: join(dir, "pid"),
      SKEP_PTY_NODE: "example-node",
      SKEP_PTY_HELPER: "example-helper.js",
      EXAMPLE: "local-example",
    };
    child = new ChildProcess();
    vi.mocked(spawn).mockReset().mockReturnValue(child);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes its own 0600 pid and inherits PTY stdio without leaking helper variables", async () => {
    const run = runPtyHelper(env);
    expect(await readFile(env.SKEP_PTY_PIDFILE ?? "", "utf8")).toBe(`${process.pid}\n`);
    expect((await stat(env.SKEP_PTY_PIDFILE ?? "")).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["pid"]);
    expect(spawn).toHaveBeenCalledWith("example-agent", ["spaces; $(example)", "line\nbreak"], {
      shell: false,
      stdio: "inherit",
      env: { EXAMPLE: "local-example" },
    });
    child.emit("exit", 7, null);
    expect(await run).toBe(7);
  });

  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)(
    "maps %s to the conventional signal exit",
    async (signal) => {
      const run = runPtyHelper(env);
      child.emit("exit", null, signal);
      expect(await run).toBe(128 + constants.signals[signal]);
    },
  );

  it.each(["invalid JSON", "{}", "[]", '[""]', "[1]", '["example",1]', '["example\\u0000"]'])(
    "validates the external argv before publishing its pid: %s",
    async (argv) => {
      env.SKEP_PTY_ARGV = argv;
      await expect(runPtyHelper(env)).rejects.toBeInstanceOf(PtyHelperError);
      expect(spawn).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it("requires a sidecar path", async () => {
    delete env.SKEP_PTY_PIDFILE;
    await expect(runPtyHelper(env)).rejects.toMatchObject({
      name: "PtyHelperError",
      message: expect.stringContaining("SKEP_PTY_PIDFILE"),
    });
  });

  it("reports sidecar publication failures with a typed error", async () => {
    await writeFile(`${env.SKEP_PTY_PIDFILE}.pending`, "existing");
    await expect(runPtyHelper(env)).rejects.toMatchObject({
      name: "PtyHelperError",
      message: expect.stringContaining("sidecar"),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports agent spawn failures and removes its TERM listener", async () => {
    const listeners = process.listenerCount("SIGTERM");
    const run = runPtyHelper(env);
    child.emit("error", Object.assign(new Error("Example agent missing"), { code: "ENOENT" }));
    await expect(run).rejects.toBeInstanceOf(PtyHelperError);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it("keeps the helper alive on TERM so it can reap the signaled agent", async () => {
    const listeners = process.listenerCount("SIGTERM");
    const run = runPtyHelper(env);
    expect(process.listenerCount("SIGTERM")).toBe(listeners + 1);
    process.emit("SIGTERM");
    child.emit("exit", null, "SIGTERM");
    expect(await run).toBe(143);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });
});
