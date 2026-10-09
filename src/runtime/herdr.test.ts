import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecError, type ExecResult, type execFileChecked } from "../util/exec.js";
import {
  AgentSessionError,
  createHerdrBackend,
  HerdrCallError,
  HerdrSchemaError,
  HerdrUnavailableError,
  SUPPORTED_HERDR_PROTOCOLS,
} from "./herdr.js";
import type { AgentSessionBackend, AgentSessionHandle, AgentSessionStart } from "./types.js";

function result(stdout: string, code: number | null = 0): ExecResult {
  return { stdout, stderr: "", code, signal: null, timedOut: false };
}

async function fixture(name: string): Promise<ExecResult> {
  return result(
    await readFile(new URL(`../../test/fixtures/herdr/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("herdr session backend", () => {
  const exec = vi.fn<typeof execFileChecked>();
  let backend: AgentSessionBackend;
  let cwd: string;
  let opts: AgentSessionStart;

  beforeEach(async () => {
    exec.mockReset();
    backend = createHerdrBackend({ exec });
    cwd = await mkdtemp(join(tmpdir(), "skep-herdr-"));
    opts = { name: "skep-example", kind: "codex", cwd, env: {} };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  async function start(): Promise<AgentSessionHandle> {
    exec.mockResolvedValueOnce(await fixture("schema"));
    exec.mockResolvedValueOnce(await fixture("tab-created"));
    exec.mockResolvedValueOnce(await fixture("agent-started"));
    return backend.start(opts);
  }
  async function prompted(): Promise<AgentSessionHandle> {
    const handle = await start();
    exec.mockResolvedValueOnce(await fixture("agent-prompted"));
    await backend.prompt(handle, "Example task");
    return handle;
  }

  it("probes the locally exported compatibility fields with --json", async () => {
    exec.mockResolvedValueOnce(await fixture("schema"));
    expect(await backend.probe()).toEqual({ protocol: 22, schemaVersion: 1 });
    expect(SUPPORTED_HERDR_PROTOCOLS).toEqual([22]);
    expect(backend.name).toBe("herdr");
    expect(exec).toHaveBeenCalledWith(
      "herdr",
      ["api", "schema", "--json"],
      expect.objectContaining({ allowFailure: true }),
    );
  });

  it.each([
    { protocol: 21, schema_version: 1 },
    { protocol: 23, schema_version: 1 },
    { protocol: 22, schema_version: 2 },
    { protocol: "22", schema_version: 1 },
    { protocol: 22 },
    { protocol: 22, schema_version: 1, unexpected: true },
    null,
  ])("rejects incompatible or malformed metadata: %j", async (value) => {
    exec.mockResolvedValueOnce(result(JSON.stringify(value)));
    await expect(backend.start(opts)).rejects.toMatchObject({
      name: "HerdrSchemaError",
      fallbackSafe: true,
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON schema metadata with HerdrSchemaError", async () => {
    exec.mockResolvedValueOnce(result("invalid json"));
    await expect(backend.probe()).rejects.toBeInstanceOf(HerdrSchemaError);
  });

  it.each([false, true])(
    "recognizes ENOENT including the checked exec wrapper (%s)",
    async (wrapped) => {
      const cause = Object.assign(new Error("binary missing"), { code: "ENOENT" });
      exec.mockRejectedValueOnce(
        wrapped ? new ExecError("herdr", [], result("", 1), { cause }) : cause,
      );
      await expect(backend.probe()).rejects.toMatchObject({
        name: "HerdrUnavailableError",
        fallbackSafe: true,
      });
    },
  );

  it("recognizes a server that is not running", async () => {
    exec.mockResolvedValueOnce({ ...result("", 1), stderr: "herdr server is not running" });
    await expect(backend.probe()).rejects.toBeInstanceOf(HerdrUnavailableError);
  });

  it.each(["codex", "claude", "pi"] as const)(
    "creates a tab and starts %s with argv only",
    async (kind) => {
      opts.kind = kind;
      opts.env = { EXAMPLE: "spaces; $(example)\nquoted='value'" };
      opts.args = ["--example", "$(example); 'quoted'", "argument with spaces"];
      const h = await start();
      expect(h).toEqual({
        name: opts.name,
        paneId: "workspace:pane",
        focusCommand: ["herdr", "agent", "focus", opts.name],
      });
      expect(exec.mock.calls[1]?.[1]).toEqual([
        "tab",
        "create",
        "--cwd",
        cwd,
        "--label",
        opts.name,
        "--no-focus",
        "--env",
        `EXAMPLE=${opts.env.EXAMPLE}`,
      ]);
      expect(exec.mock.calls[2]?.[1]).toEqual([
        "agent",
        "start",
        opts.name,
        "--kind",
        kind,
        "--pane",
        h.paneId,
        "--",
        ...opts.args,
      ]);
      expect(exec.mock.calls.flatMap((call) => call[1])).not.toContain("--machine");
    },
  );

  it("honors an injected binary and does not forward ambient credentials", async () => {
    vi.stubEnv("EXAMPLE_KEY", "example-value");
    backend = createHerdrBackend({ exec, bin: "example-herdr" });
    const h = await start();
    expect(h.focusCommand[0]).toBe("example-herdr");
    for (const call of exec.mock.calls) {
      expect(call[0]).toBe("example-herdr");
      expect(call[2]?.env).not.toHaveProperty("EXAMPLE_KEY");
    }
  });

  it.each(["", "Example", "-example", "example_1", "a".repeat(65)])(
    "validates session name %j before I/O",
    async (name) => {
      opts.name = name;
      await expect(backend.start(opts)).rejects.toMatchObject({
        code: "invalid_input",
        fallbackSafe: true,
      });
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown success fields instead of silently accepting a new contract", async () => {
    exec.mockResolvedValueOnce(await fixture("schema"));
    const created = JSON.parse((await fixture("tab-created")).stdout) as {
      result: Record<string, unknown>;
    };
    created.result.extra = true;
    exec.mockResolvedValueOnce(result(JSON.stringify(created)));
    await expect(backend.start(opts)).rejects.toMatchObject({
      code: "invalid_response",
      fallbackSafe: true,
    });
  });

  it("closes a newly created pane after startup fails", async () => {
    exec.mockResolvedValueOnce(await fixture("schema"));
    exec.mockResolvedValueOnce(await fixture("tab-created"));
    exec.mockResolvedValueOnce(
      result(
        JSON.stringify({
          id: "cli:agent:start",
          error: { code: "agent_not_ready", message: "Example startup failed" },
        }),
        1,
      ),
    );
    exec.mockResolvedValueOnce(await fixture("ok"));
    await expect(backend.start(opts)).rejects.toMatchObject({
      code: "agent_not_ready",
      fallbackSafe: true,
    });
    expect(exec.mock.calls.at(-1)?.[1]).toEqual(["pane", "close", "workspace:pane"]);
  });

  it("sends prompt text as one unquoted argv element with no --wait", async () => {
    const h = await start();
    const text = "Example 'quoted' prompt; $(example)\nSecond line";
    exec.mockResolvedValueOnce(await fixture("agent-prompted"));
    await backend.prompt(h, text);
    expect(exec.mock.calls.at(-1)?.[1]).toEqual(["agent", "prompt", h.name, text]);
  });

  it("keeps a 16 KiB prompt in argv", async () => {
    const h = await start();
    const text = "x".repeat(16 * 1024);
    exec.mockResolvedValueOnce(await fixture("agent-prompted"));
    await backend.prompt(h, text);
    expect(exec.mock.calls.at(-1)?.[1][3]).toBe(text);
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(["x".repeat(16 * 1024 + 1), "é".repeat(8193)])(
    "writes oversized UTF-8 prompts to a private worktree file",
    async (text) => {
      const h = await start();
      exec.mockResolvedValueOnce(await fixture("agent-prompted"));
      await backend.prompt(h, text);
      const dirs = await readdir(cwd);
      expect(dirs).toHaveLength(1);
      const file = join(cwd, dirs[0] ?? "", "prompt.txt");
      expect(await readFile(file, "utf8")).toBe(text);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const payload = exec.mock.calls.at(-1)?.[1][3] ?? "";
      expect(payload).toContain(join(dirs[0] ?? "", "prompt.txt"));
      expect(payload).not.toContain("\n");
      expect(Buffer.byteLength(payload)).toBeLessThan(16 * 1024);
      exec.mockResolvedValueOnce(await fixture("ok"));
      await backend.close(h);
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it.each(["idle", "done", "blocked"] as const)(
    "waits for the first terminal state: %s",
    async (state) => {
      const h = await prompted();
      const waited = JSON.parse((await fixture("wait")).stdout) as {
        result: { agent: { agent_status: string } };
      };
      waited.result.agent.agent_status = state;
      exec.mockResolvedValueOnce(result(JSON.stringify(waited)));
      const signal = new AbortController().signal;
      expect(await backend.wait(h, { timeoutMs: 123, signal })).toBe(state);
      expect(exec.mock.calls.at(-1)?.[1]).toEqual([
        "agent",
        "wait",
        h.name,
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        "123",
      ]);
      expect(exec.mock.calls.at(-1)?.[2]).toMatchObject({ signal, timeoutMs: 1123 });
    },
  );

  it("maps agent_blocked from wait to the blocked state", async () => {
    const h = await prompted();
    exec.mockResolvedValueOnce({ ...(await fixture("error-agent-blocked")), code: 1 });
    expect(await backend.wait(h, { timeoutMs: 100 })).toBe("blocked");
  });

  it.each([false, true])(
    "rejects timeout and preserves prompt acceptance (%s)",
    async (accepted) => {
      const h = accepted ? await prompted() : await start();
      exec.mockResolvedValueOnce({ ...(await fixture("error-timeout")), code: 1 });
      await expect(backend.wait(h, { timeoutMs: 100 })).rejects.toMatchObject({
        name: "HerdrCallError",
        code: "timeout",
        fallbackSafe: !accepted,
      });
    },
  );

  it("recognizes error_response JSON on stderr", async () => {
    const h = await prompted();
    exec.mockResolvedValueOnce({
      ...result("", 1),
      stderr: (await fixture("error-timeout")).stdout,
    });
    await expect(backend.wait(h, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
      fallbackSafe: false,
    });
  });

  it("treats the locally captured prompt-stalled failure as an accepted invocation", async () => {
    const h = await start();
    exec.mockResolvedValueOnce({ ...(await fixture("error-prompt-stalled")), code: 1 });
    await expect(backend.prompt(h, "Example task")).rejects.toMatchObject({
      code: "agent_prompt_stalled",
      fallbackSafe: false,
    });
    exec.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(backend.read(h)).rejects.toMatchObject({
      code: "unavailable",
      fallbackSafe: false,
    });
  });

  it("never offers native fallback after a lost prompt acknowledgement", async () => {
    const h = await start();
    exec.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(backend.prompt(h, "Example task")).rejects.toMatchObject({
      code: "exec_failed",
      fallbackSafe: false,
    });
  });

  it("allows fallback on an explicit prompt rejection", async () => {
    const h = await start();
    exec.mockResolvedValueOnce(
      result(
        JSON.stringify({
          id: "cli:agent:prompt",
          error: { code: "agent_not_found", message: "Example agent not found" },
        }),
        1,
      ),
    );
    await expect(backend.prompt(h, "Example task")).rejects.toMatchObject({
      code: "agent_not_found",
      fallbackSafe: true,
    });
  });

  it("does not replay a prompt that reaches a blocked agent", async () => {
    const h = await start();
    exec.mockResolvedValueOnce({ ...(await fixture("error-agent-blocked")), code: 1 });
    await expect(backend.prompt(h, "Example task")).rejects.toMatchObject({
      code: "agent_blocked",
      fallbackSafe: false,
    });
  });

  it("keeps acceptance separate for concurrent sessions", async () => {
    const first = await prompted();
    opts.name = "skep-example-2";
    exec.mockResolvedValueOnce(await fixture("tab-created"));
    const response = JSON.parse((await fixture("agent-started")).stdout) as {
      result: { agent: { name: string } };
    };
    response.result.agent.name = opts.name;
    exec.mockResolvedValueOnce(result(JSON.stringify(response)));
    const second = await backend.start(opts);
    exec.mockResolvedValueOnce({ ...(await fixture("error-timeout")), code: 1 });
    await expect(backend.wait(second, { timeoutMs: 100 })).rejects.toMatchObject({
      fallbackSafe: true,
    });
    exec.mockResolvedValueOnce({ ...(await fixture("error-timeout")), code: 1 });
    await expect(backend.wait(first, { timeoutMs: 100 })).rejects.toMatchObject({
      fallbackSafe: false,
    });
  });

  it("preserves JSON-looking agent output as plain text", async () => {
    const h = await prompted();
    const text = (await fixture("error-timeout")).stdout;
    exec.mockResolvedValueOnce(result(text));
    expect(await backend.read(h)).toBe(text);
  });

  it("allows fallback if the prompt executable never starts", async () => {
    const h = await start();
    exec.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(backend.prompt(h, "Example task")).rejects.toMatchObject({
      name: "HerdrUnavailableError",
      fallbackSafe: true,
    });
  });

  it.each(["missing", "invalid_json", "timeout", "abort"])(
    "fails safely after prompt acceptance on %s",
    async (failure) => {
      const h = await prompted();
      if (failure === "missing")
        exec.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
      if (failure === "abort")
        exec.mockRejectedValueOnce(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      if (failure === "invalid_json") exec.mockResolvedValueOnce(result("not json"));
      if (failure === "timeout")
        exec.mockResolvedValueOnce({
          ...result("", null),
          timedOut: true,
          signal: "SIGTERM",
        });
      await expect(backend.wait(h, { timeoutMs: 100 })).rejects.toMatchObject({
        name: "HerdrCallError",
        fallbackSafe: false,
      });
    },
  );

  it("reads plain text unchanged, focuses by name and closes by pane id", async () => {
    const h = await prompted();
    const text = "Example raw output\nwith 'quotes' and ANSI \x1b[31mtext\x1b[0m\n";
    exec.mockResolvedValueOnce(result(text));
    expect(await backend.read(h, { lines: 42 })).toBe(text);
    expect(exec.mock.calls.at(-1)?.[1]).toEqual([
      "agent",
      "read",
      h.name,
      "--source",
      "recent",
      "--lines",
      "42",
      "--format",
      "text",
    ]);
    exec.mockResolvedValueOnce(await fixture("ok"));
    await backend.focus(h);
    expect(exec.mock.calls.at(-1)?.[1]).toEqual(["agent", "focus", h.name]);
    exec.mockResolvedValueOnce(await fixture("ok"));
    await backend.close(h);
    expect(exec.mock.calls.at(-1)?.[1]).toEqual(["pane", "close", h.paneId]);
  });

  it("provides typed errors with the binding fallback contract", () => {
    expect(new HerdrCallError("timeout")).toBeInstanceOf(AgentSessionError);
    expect(new HerdrCallError("timeout").fallbackSafe).toBe(true);
    expect(new HerdrCallError("timeout", "Example timeout", true).fallbackSafe).toBe(false);
  });
});
