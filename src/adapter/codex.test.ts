import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessExit, ProcessHandle, RuntimeBackend, SpawnOptions } from "../runtime/types.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import {
  CodexAdapter,
  CodexAdapterError,
  type InterruptLadder,
  PINNED_CODEX_VERSION,
  toCodexOutputSchema,
} from "./codex.js";
import type { AdapterInvocation, AgentAdapter } from "./types.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FixtureRuntime implements RuntimeBackend {
  readonly name = "native";
  readonly calls: SpawnOptions[] = [];
  readonly spawned = deferred<void>();
  readonly exit = deferred<ProcessExit>();
  readonly handle: ProcessHandle = {
    pid: 1001,
    pgid: 1001,
    startToken: "example-start",
    wait: () => this.exit.promise,
    signalGroup: vi.fn(),
  };
  fixture = "success";
  log: string | null = null;
  finalMessage: string | null = '{"ok":true}';
  hang = false;
  code = 0;
  version = PINNED_CODEX_VERSION;
  spawnError: Error | null = null;
  readonly beforeReturn = deferred<void>();
  holdSpawn = false;

  async spawn(opts: SpawnOptions): Promise<ProcessHandle> {
    this.calls.push(opts);
    if (this.spawnError) throw this.spawnError;
    if (opts.argv.includes("--version")) {
      await writeFile(opts.logPath, `WARNING: example diagnostic\n${this.version}\n`);
    } else {
      const text =
        this.log ??
        (await readFile(path.resolve(`test/fixtures/codex/${this.fixture}.jsonl`), "utf8"));
      await writeFile(opts.logPath, text);
      const finalPath = opts.argv[opts.argv.indexOf("--output-last-message") + 1];
      if (this.finalMessage !== null && finalPath) {
        await writeFile(finalPath, this.finalMessage);
      }
    }
    this.spawned.resolve();
    if (this.holdSpawn) await this.beforeReturn.promise;
    if (!this.hang) this.finish();
    return this.handle;
  }

  async isAlive(): Promise<boolean> {
    return this.hang;
  }

  finish(exit: ProcessExit = { code: this.code, signal: null }): void {
    this.hang = false;
    this.exit.resolve(exit);
  }
}

describe("CodexAdapter", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup() {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-codex-test-"));
    dirs.push(dir);
    const time = new VirtualTime();
    const clock = new FakeClock(time);
    const runtime = new FixtureRuntime();
    const interrupt = vi.fn<InterruptLadder>(async () => {
      runtime.finish({ code: null, signal: "SIGINT" });
      return "interrupted";
    });
    const adapter: AgentAdapter = new CodexAdapter({ runtime, interrupt, clock });
    const abort = new AbortController();
    const inv: AdapterInvocation = {
      kind: "work",
      cwd: dir,
      prompt: "Return an example report. Literal characters: $(example) `example`",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      timeoutMs: 1000,
      env: { PATH: "/usr/bin", HOME: path.join(dir, "agent-home"), LANG: "C.UTF-8" },
      logPath: path.join(dir, "capture.log"),
      scratchDir: path.join(dir, "scratch"),
      signal: abort.signal,
    };
    return { adapter, inv, runtime, interrupt, abort, clock, time, dir };
  }

  it("replays success, writes the schema, and uses stdin plus credential-free argv", async () => {
    const { adapter, inv, runtime, interrupt } = await setup();
    const result = await adapter.invoke(inv);
    expect(result).toEqual({
      outcome: "completed",
      exitCode: 0,
      finalMessage: '{"ok":true}',
      usage: { input_tokens: 120, output_tokens: 12 },
      durationMs: 0,
      pid: 1001,
    });
    expect(adapter.cli).toBe("codex");
    expect(runtime.calls).toEqual([
      {
        argv: [
          "codex",
          "-c",
          'approval_policy="never"',
          "exec",
          "--json",
          "--output-schema",
          path.join(inv.scratchDir, "schema.json"),
          "--output-last-message",
          path.join(inv.scratchDir, "last.json"),
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          inv.cwd,
          "-",
        ],
        cwd: inv.cwd,
        env: inv.env,
        logPath: inv.logPath,
        stdin: inv.prompt,
      },
    ]);
    expect(runtime.calls[0]?.argv.join(" ")).not.toContain(inv.prompt);
    expect(runtime.calls[0]?.argv.join(" ")).not.toMatch(/TOKEN|SECRET|API_KEY|auth/i);
    expect(runtime.calls[0]?.env).toBe(inv.env);
    expect(JSON.parse(await readFile(path.join(inv.scratchDir, "schema.json"), "utf8"))).toEqual({
      type: "object",
      properties: { ok: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
      required: ["ok"],
      additionalProperties: false,
    });
    expect(await readFile(inv.logPath, "utf8")).toContain('"turn.completed"');
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("returns invalid final JSON verbatim for the structured runner's repair", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.finalMessage = "```json\n{broken\n```";
    expect(await adapter.invoke(inv)).toMatchObject({
      outcome: "completed",
      finalMessage: runtime.finalMessage,
    });
  });

  it("returns null for a missing final message and removes stale scratch output", async () => {
    const { adapter, inv, runtime } = await setup();
    await mkdir(inv.scratchDir);
    await writeFile(path.join(inv.scratchDir, "last.json"), '{"stale":true}');
    runtime.finalMessage = null;
    runtime.code = 1;
    expect(await adapter.invoke(inv)).toMatchObject({
      outcome: "completed",
      exitCode: 1,
      finalMessage: null,
    });
  });

  it("reports absent usage as null without inferring it from assistant text", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.fixture = "missing-usage";
    runtime.finalMessage = '{"input_tokens":99}';
    expect((await adapter.invoke(inv)).usage).toBeNull();
  });

  it("maps legacy token-count totals through the shared Usage schema", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.fixture = "token-count";
    expect((await adapter.invoke(inv)).usage).toEqual({ input_tokens: 80, output_tokens: 8 });
  });

  it.each([-1, 1.5, "20", null])("ignores invalid usage counter %s", async (counter) => {
    const { adapter, inv, runtime } = await setup();
    runtime.log = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: counter, output_tokens: 3 },
    });
    expect((await adapter.invoke(inv)).usage).toBeNull();
  });

  it("uses the last valid usage event and tolerates warnings and a torn final log line", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.log = [
      "WARNING: example diagnostic",
      "not JSON",
      "null",
      '{"unknown":true}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}',
      '{"type":"turn.completed",',
    ].join("\n");
    expect((await adapter.invoke(inv)).usage).toEqual({ input_tokens: 4, output_tokens: 5 });
  });

  it("stops a live approval request through the injected ladder", async () => {
    const { adapter, inv, runtime, interrupt, clock } = await setup();
    runtime.fixture = "approval";
    runtime.hang = true;
    const result = await adapter.invoke(inv);
    expect(result.outcome).toBe("permission_prompt");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(runtime.handle, clock);
  });

  it.each([
    { type: "approval_request" },
    { type: "item.started", item: { type: "command_execution_approval_requested" } },
    { type: "codex/event", msg: { type: "apply_patch_approval_request" } },
    { type: "request_user_input" },
  ])("recognizes approval event %j even when the CLI has already exited", async (event) => {
    const { adapter, inv, runtime, interrupt } = await setup();
    runtime.log = JSON.stringify(event);
    expect((await adapter.invoke(inv)).outcome).toBe("permission_prompt");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("handles an approval record split across writes while the process is still alive", async () => {
    const { adapter, inv, runtime, interrupt, time } = await setup();
    runtime.log = '{"type":"exec_approval_';
    runtime.hang = true;
    const result = adapter.invoke(inv);
    await runtime.spawned.promise;
    // Wait for supervision's first poll to finish before advancing the virtual clock.
    await vi.waitFor(() => expect(time.nextTimerAt()).not.toBeNull());
    await appendFile(inv.logPath, 'request","reason":"example café"}\n');
    await time.advance(50);
    expect((await result).outcome).toBe("permission_prompt");
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("enforces timeout with injected time and preserves timeout after escalation", async () => {
    const { adapter, inv, runtime, interrupt, clock, time } = await setup();
    runtime.hang = true;
    interrupt.mockImplementation(async () => {
      runtime.finish({ code: null, signal: "SIGKILL" });
      return "killed";
    });
    const result = adapter.invoke(inv);
    await runtime.spawned.promise;
    await vi.waitFor(() => expect(time.nextTimerAt()).not.toBeNull());
    await time.advance(inv.timeoutMs);
    expect(await result).toMatchObject({ outcome: "timeout", exitCode: null, durationMs: 1000 });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(runtime.handle, clock);
    expect(time.nextTimerAt()).toBeNull();
  });

  it.each(["interrupted", "killed", "completed"] as const)(
    "maps abort to the ladder's %s result",
    async (outcome) => {
      const { adapter, inv, runtime, interrupt, abort, clock, time } = await setup();
      runtime.hang = true;
      interrupt.mockImplementation(async () => {
        runtime.finish({ code: outcome === "completed" ? 0 : null, signal: "SIGINT" });
        return outcome;
      });
      const result = adapter.invoke(inv);
      await runtime.spawned.promise;
      abort.abort();
      expect((await result).outcome).toBe(outcome);
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(runtime.handle, clock);
      expect(time.nextTimerAt()).toBeNull();
    },
  );

  it("does not spawn for an already-aborted invocation", async () => {
    const { adapter, inv, runtime, interrupt, abort } = await setup();
    abort.abort();
    expect(await adapter.invoke(inv)).toEqual({
      outcome: "interrupted",
      exitCode: null,
      finalMessage: null,
      usage: null,
      durationMs: 0,
      pid: null,
    });
    expect(runtime.calls).toHaveLength(0);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("remembers an abort while runtime.spawn is pending", async () => {
    const { adapter, inv, runtime, interrupt, abort } = await setup();
    runtime.hang = true;
    runtime.holdSpawn = true;
    const result = adapter.invoke(inv);
    await runtime.spawned.promise;
    abort.abort();
    runtime.beforeReturn.resolve();
    expect((await result).outcome).toBe("interrupted");
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("counts time spent spawning against the invocation deadline", async () => {
    const { adapter, inv, runtime, time } = await setup();
    runtime.hang = true;
    runtime.holdSpawn = true;
    const result = adapter.invoke(inv);
    await runtime.spawned.promise;
    await time.advance(inv.timeoutMs);
    runtime.beforeReturn.resolve();
    await vi.waitFor(() => expect(time.nextTimerAt()).toBe(1000));
    await time.advance(0);
    expect((await result).outcome).toBe("timeout");
  });

  it("cleans up monitoring timers and abort listeners on normal completion", async () => {
    const { adapter, inv, time, abort, interrupt } = await setup();
    await adapter.invoke(inv);
    expect(time.nextTimerAt()).toBeNull();
    abort.abort();
    await time.advance(5000);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("supports an explicitly selected executable path", async () => {
    const { inv, runtime, interrupt, clock } = await setup();
    const adapter = new CodexAdapter({ runtime, interrupt, clock, codexPath: "/example/codex" });
    await adapter.invoke(inv);
    expect(runtime.calls[0]?.argv[0]).toBe("/example/codex");
  });

  it("probes only the version, ignores stderr warnings, and passes no inherited environment", async () => {
    const { adapter, runtime, interrupt, time } = await setup();
    expect(await adapter.probe()).toMatchObject({ ok: true, version: PINNED_CODEX_VERSION });
    expect(runtime.calls[0]).toMatchObject({ argv: ["codex", "--version"], env: {}, stdin: "" });
    expect(interrupt).not.toHaveBeenCalled();
    expect(time.nextTimerAt()).toBeNull();
    const logPath = runtime.calls[0]?.logPath;
    expect(logPath).toBeDefined();
    await expect(readFile(logPath ?? "", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports any available version so the daemon can enforce the AGENT.md pin", async () => {
    const { adapter, runtime } = await setup();
    runtime.version = "codex-cli 0.1.0";
    expect(await adapter.probe()).toMatchObject({ ok: true, version: "codex-cli 0.1.0" });
    expect(runtime.calls).toHaveLength(1);
  });

  it("passes only an explicit PATH to the version probe", async () => {
    const { runtime, interrupt, clock } = await setup();
    const adapter = new CodexAdapter({
      runtime,
      interrupt,
      clock,
      probeEnv: { PATH: "/example/bin" },
    });
    expect((await adapter.probe()).ok).toBe(true);
    expect(runtime.calls[0]?.env).toEqual({ PATH: "/example/bin" });
  });

  it("rejects a successful probe without a recognizable version", async () => {
    const { adapter, runtime } = await setup();
    runtime.version = "example diagnostic";
    expect(await adapter.probe()).toMatchObject({ ok: false, version: null });
  });

  it("writes the transformed real WorkReport schema without changing the invocation schema", async () => {
    const { WorkReportSchema } = await import("../core/schemas/work-report.js");
    const { z } = await import("zod");
    const { adapter, inv } = await setup();
    inv.outputSchema = z.toJSONSchema(WorkReportSchema);
    const original = structuredClone(inv.outputSchema);
    await adapter.invoke(inv);
    expect(JSON.parse(await readFile(path.join(inv.scratchDir, "schema.json"), "utf8"))).toEqual(
      toCodexOutputSchema(original),
    );
    expect(inv.outputSchema).toEqual(original);
  });

  it("uses strict output mode by default and never silently retries a rejected schema", async () => {
    const { adapter, inv, runtime, interrupt } = await setup();
    runtime.fixture = "invalid-schema";
    runtime.code = 1;
    runtime.finalMessage = null;
    await expect(adapter.invoke(inv)).rejects.toMatchObject({
      name: "CodexAdapterError",
      message: expect.stringContaining("invalid_json_schema"),
    });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.argv).toContain("--output-schema");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("stops a still-running CLI after a schema-configuration error", async () => {
    const { adapter, inv, runtime, interrupt } = await setup();
    runtime.fixture = "invalid-schema";
    runtime.hang = true;
    await expect(adapter.invoke(inv)).rejects.toThrow(/configuration error/);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("recognizes invalid_json_schema in plain stderr diagnostics", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.log = "ERROR: invalid_json_schema: example schema rejected\n";
    await expect(adapter.invoke(inv)).rejects.toBeInstanceOf(CodexAdapterError);
  });

  it("recognizes a bare provider error response without a JSONL event type", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.log = JSON.stringify({
      error: { code: "invalid_json_schema", message: "Example schema rejected" },
    });
    await expect(adapter.invoke(inv)).rejects.toThrow(/invalid_json_schema/);
  });

  it("does not treat assistant discussion of invalid_json_schema as a provider error", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.log = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "invalid_json_schema" },
    });
    expect((await adapter.invoke(inv)).outcome).toBe("completed");
  });

  it.each([false, true])(
    "passes the prompt unchanged in off mode (embedded schema=%s)",
    async (embedded) => {
      const { inv, runtime, interrupt, clock } = await setup();
      if (embedded) inv.prompt += `\nJSON Schema:\n${JSON.stringify(inv.outputSchema)}\n`;
      const adapter = new CodexAdapter({ runtime, interrupt, clock, outputSchema: "off" });
      expect((await adapter.invoke(inv)).finalMessage).toBe(runtime.finalMessage);
      expect(runtime.calls).toHaveLength(1);
      const spawned = runtime.calls[0];
      expect(spawned?.argv).not.toContain("--output-schema");
      expect(spawned?.argv).toContain("--output-last-message");
      expect(spawned?.stdin).toBe(inv.prompt);
      expect(spawned?.env).toBe(inv.env);
      await expect(readFile(path.join(inv.scratchDir, "schema.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("reports a missing CLI as an actionable probe failure", async () => {
    const { adapter, runtime } = await setup();
    runtime.spawnError = new Error("example executable not found");
    expect(await adapter.probe()).toMatchObject({
      ok: false,
      version: null,
      detail: expect.stringContaining("not found"),
    });
  });

  it("bounds the version probe with the same injected ladder", async () => {
    const { adapter, runtime, interrupt, time } = await setup();
    runtime.hang = true;
    const probe = adapter.probe();
    await runtime.spawned.promise;
    await vi.waitFor(() => expect(time.nextTimerAt()).not.toBeNull());
    await time.advance(5000);
    expect(await probe).toMatchObject({ ok: false, version: null });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects timeout %s",
    async (timeoutMs) => {
      const { adapter, inv, runtime } = await setup();
      await expect(adapter.invoke({ ...inv, timeoutMs })).rejects.toBeInstanceOf(CodexAdapterError);
      expect(runtime.calls).toHaveLength(0);
    },
  );

  it("wraps spawn failures in a typed actionable error", async () => {
    const { adapter, inv, runtime } = await setup();
    runtime.spawnError = new Error("example spawn failure");
    await expect(adapter.invoke(inv)).rejects.toMatchObject({
      name: "CodexAdapterError",
      cause: runtime.spawnError,
    });
  });

  it("stops a running CLI if a log record exceeds the bounded capture limit", async () => {
    const { adapter, inv, runtime, interrupt } = await setup();
    runtime.hang = true;
    runtime.log = "x".repeat(1024 * 1024 + 1);
    await expect(adapter.invoke(inv)).rejects.toThrow(/1 MiB/);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("decodes usage split in the middle of a UTF-8 character and a JSONL record", async () => {
    const { adapter, inv, runtime, time } = await setup();
    runtime.hang = true;
    const text = Buffer.from(
      '{"type":"turn.completed","note":"café","usage":{"input_tokens":2,"output_tokens":1}}',
    );
    const split = text.indexOf(Buffer.from("é")) + 1;
    runtime.log = "";
    const result = adapter.invoke(inv);
    await runtime.spawned.promise;
    await appendFile(inv.logPath, text.subarray(0, split));
    await vi.waitFor(() => expect(time.nextTimerAt()).not.toBeNull());
    await time.advance(50);
    await appendFile(inv.logPath, text.subarray(split));
    runtime.finish();
    expect((await result).usage).toEqual({ input_tokens: 2, output_tokens: 1 });
  });
});
