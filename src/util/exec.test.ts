import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecError, execFileChecked } from "./exec.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe("execFileChecked", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-exec-"));
    dirs.push(dir);
    return dir;
  }

  it("passes shell metacharacters literally and never sets shell (AC 1)", async () => {
    const dir = await scratch();
    const marker = path.join(dir, "pwned");
    const arg = `; echo pwned $(id) > ${marker}`;
    const result = await execFileChecked(
      "node",
      ["-e", "process.stdout.write(process.argv[1])", arg],
      { env: { PATH: process.env.PATH ?? "" } },
    );

    expect(result).toEqual({ code: 0, signal: null, stdout: arg, stderr: "", timedOut: false });
    await expect(rm(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(execFile).toHaveBeenCalledWith(
      "node",
      ["-e", "process.stdout.write(process.argv[1])", arg],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
  });

  it("throws ExecError with stdout and stderr on a non-zero exit", async () => {
    const error = await execFileChecked(
      "node",
      ["-e", "process.stdout.write('partial'); process.stderr.write('nope'); process.exit(3)"],
      { env: { PATH: process.env.PATH ?? "" } },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecError);
    const execError = error as ExecError;
    expect(execError.file).toBe("node");
    expect(execError.args[0]).toBe("-e");
    expect(execError.result).toMatchObject({ code: 3, signal: null, timedOut: false });
    expect(execError.result.stdout).toContain("partial");
    expect(execError.result.stderr).toContain("nope");
  });

  it("returns the result instead of throwing when allowFailure is set", async () => {
    const result = await execFileChecked("node", ["-e", "process.exit(2)"], {
      allowFailure: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result).toMatchObject({ code: 2, signal: null, timedOut: false });
  });

  it("kills the child on timeoutMs and reports timedOut", async () => {
    const error = await execFileChecked("node", ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 200,
      env: { PATH: process.env.PATH ?? "" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).result.timedOut).toBe(true);
  });

  it("returns a timed-out result when allowFailure is set", async () => {
    const result = await execFileChecked("node", ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 200,
      allowFailure: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it("throws ExecError when output exceeds maxBufferBytes", async () => {
    const error = await execFileChecked("node", ["-e", "process.stdout.write('x'.repeat(4096))"], {
      maxBufferBytes: 128,
      env: { PATH: process.env.PATH ?? "" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecError);
    const execError = error as ExecError;
    expect(execError.result.timedOut).toBe(false);
    expect(execError.result.stdout.length).toBeLessThanOrEqual(128);
  });

  it("gives the child exactly the env it was passed and nothing else", async () => {
    const result = await execFileChecked(
      "node",
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: { SKEP_ONLY: "present" } },
    );
    expect(JSON.parse(result.stdout)).toEqual({ SKEP_ONLY: "present" });
  });

  it("passes an empty environment when env is omitted", async () => {
    const result = await execFileChecked("node", [
      "-e",
      "process.stdout.write(JSON.stringify(process.env))",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("writes stdin from a string or bytes", async () => {
    const dir = await scratch();
    const script = path.join(dir, "echo.js");
    await writeFile(script, "process.stdin.pipe(process.stdout)");
    const text = await execFileChecked("node", [script], { input: "hello" });
    const bytes = await execFileChecked("node", [script], {
      input: new Uint8Array(Buffer.from("bytes")),
    });
    expect(text.stdout).toBe("hello");
    expect(bytes.stdout).toBe("bytes");
  });

  it("closes stdin when no input is given, so a child reading stdin exits", async () => {
    const started = Date.now();
    const result = await execFileChecked("cat", [], {
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns the truncated output instead of throwing when allowFailure meets a buffer overflow", async () => {
    const result = await execFileChecked("node", ["-e", "process.stdout.write('x'.repeat(4096))"], {
      maxBufferBytes: 128,
      allowFailure: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
  });

  it("still throws when the binary cannot be spawned, even with allowFailure", async () => {
    const error = await execFileChecked("no-such-binary-skep", [], { allowFailure: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExecError);
  });

  it("reports a signal that the child raised itself as a signal, not a timeout", async () => {
    const error = await execFileChecked("node", ["-e", "process.kill(process.pid, 'SIGKILL')"], {
      allowFailure: true,
    });
    expect(error.signal).toBe("SIGKILL");
    expect(error.timedOut).toBe(false);
  });
});
