import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CodexAdapter,
  type InterruptLadder,
  PINNED_CODEX_VERSION,
} from "../../src/adapter/codex.js";
import type { AdapterInvocation } from "../../src/adapter/types.js";
import { UsageSchema, WorkReportSchema } from "../../src/core/schemas/work-report.js";
import type {
  ProcessExit,
  ProcessHandle,
  RuntimeBackend,
  SpawnOptions,
} from "../../src/runtime/types.js";
import type { Clock } from "../../src/util/clock.js";
import { systemClock } from "../../src/util/clock.js";

// Deliberately local to this opt-in test: SK-306 owns the production runtime and PID-reuse guards.
class InlineRuntime implements RuntimeBackend {
  readonly name = "native";
  private readonly live = new Map<number, string>();
  private readonly waits: Promise<ProcessExit>[] = [];
  readonly spawnedGroups: number[] = [];
  onInvocationSpawn: (() => void) | null = null;

  async spawn(opts: SpawnOptions): Promise<ProcessHandle> {
    const file = await open(opts.logPath, "w", 0o600);
    const child = spawn(opts.argv[0], opts.argv.slice(1), {
      shell: false,
      detached: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", file.fd, file.fd],
    });
    let inputError: Error | null = null;
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      child.once("close", (code, signal) => {
        if (child.pid) this.live.delete(child.pid);
        if (inputError) reject(inputError);
        else resolve({ code, signal });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } finally {
      await file.close();
    }
    const pid = child.pid;
    if (pid === undefined) throw new Error("Codex test runtime did not receive a PID");
    const startToken = `test-process-${pid}`;
    this.live.set(pid, startToken);
    this.waits.push(exited);
    this.spawnedGroups.push(pid);
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // An early CLI exit closes stdin. Other failures must stop the test process too.
      if (error.code !== "EPIPE") {
        inputError = error;
        process.kill(-pid, "SIGKILL");
      }
    });
    child.stdin?.end(opts.stdin);
    if (opts.argv.includes("exec")) this.onInvocationSpawn?.();
    return {
      pid,
      pgid: pid,
      startToken,
      wait: () => exited,
      signalGroup: (signal) => {
        if (!this.live.has(pid)) return;
        try {
          process.kill(-pid, signal);
        } catch (error) {
          // ESRCH means the group already exited between the liveness check and the signal.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
    };
  }

  async isAlive(pgid: number, startToken: string): Promise<boolean> {
    return this.live.get(pgid) === startToken;
  }

  async cleanup(): Promise<void> {
    for (const pgid of this.live.keys()) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.allSettled(this.waits);
  }
}

async function exitsWithin(handle: ProcessHandle, clock: Clock, ms: number): Promise<boolean> {
  const cancelled = new AbortController();
  try {
    return await Promise.race([
      handle.wait().then(() => true),
      clock.sleep(ms, cancelled.signal).then(() => false),
    ]);
  } finally {
    cancelled.abort();
  }
}

// Short grace windows keep the opt-in test bounded; production defaults belong to SK-306.
const interrupt: InterruptLadder = async (handle, clock) => {
  handle.signalGroup("SIGINT");
  if (await exitsWithin(handle, clock, 5_000)) return "interrupted";
  handle.signalGroup("SIGTERM");
  if (!(await exitsWithin(handle, clock, 2_000))) handle.signalGroup("SIGKILL");
  await handle.wait();
  return "killed";
};

// Whitelist non-secret user-directory/runtime variables only. Provider secrets are never read,
// copied into env, or passed as argv. The CLI uses the human's existing local login (D19).
function sanitizedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

describe.skipIf(process.env.SKEP_REAL_CODEX !== "1")("pinned real Codex CLI (opt-in)", () => {
  const scratchDirs: string[] = [];
  const runtimes: InlineRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.cleanup()));
    await Promise.all(
      scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-codex-real-"));
    scratchDirs.push(dir);
    const runtime = new InlineRuntime();
    runtimes.push(runtime);
    const adapter = new CodexAdapter({ runtime, interrupt, clock: systemClock });
    const probe = await adapter.probe();
    expect(probe, probe.detail).toMatchObject({ ok: true, version: PINNED_CODEX_VERSION });
    const abort = new AbortController();
    const cwd = path.join(dir, "worktree");
    await mkdir(cwd);
    const inv: AdapterInvocation = {
      kind: "work",
      cwd,
      prompt:
        'Do not run tools or modify files. Return a work report with schema "skep.work_report/v1", summary "Example complete", empty files_intended and concerns, and null replan_request.',
      outputSchema: z.toJSONSchema(WorkReportSchema),
      timeoutMs: 120_000,
      env: sanitizedEnvironment(),
      logPath: path.join(dir, "capture.log"),
      scratchDir: path.join(dir, "scratch"),
      signal: abort.signal,
    };
    return { adapter, inv, runtime, abort };
  }

  it("returns a schema-valid work report without passing provider credentials", async () => {
    const { adapter, inv, runtime } = await setup();
    const result = await adapter.invoke(inv);
    expect(result).toMatchObject({ outcome: "completed", exitCode: 0 });
    expect(result.finalMessage).not.toBeNull();
    const report = WorkReportSchema.parse(JSON.parse(result.finalMessage ?? ""));
    expect(report.schema).toBe("skep.work_report/v1");
    if (result.usage !== null) expect(UsageSchema.safeParse(result.usage).success).toBe(true);
    expect(await runtime.isAlive(result.pid ?? -1, `test-process-${result.pid}`)).toBe(false);
    expect(Object.keys(inv.env)).not.toContain("OPENAI_API_KEY");
  }, 150_000);

  it("stops the detached CLI process group after SIGINT", async () => {
    const { adapter, inv, runtime, abort } = await setup();
    // Abort as soon as the real process exists; this does not depend on model/network latency.
    runtime.onInvocationSpawn = () => abort.abort();
    const result = await adapter.invoke(inv);
    expect(result.outcome).toBe("interrupted");
    expect(result.pid).not.toBeNull();
    expect(await runtime.isAlive(result.pid ?? -1, `test-process-${result.pid}`)).toBe(false);
  }, 30_000);
});
