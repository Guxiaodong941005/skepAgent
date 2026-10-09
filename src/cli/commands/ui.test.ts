import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skepPaths } from "../../config/paths.js";
import type { Clock } from "../../util/clock.js";
import { buildProgram, runCli } from "../program.js";
import type { ProcessHooks } from "../tui.js";
import type { SessionStatus } from "./session.js";
import { joinViewFactory, masterSnapshot, type UiCliContext } from "./ui.js";

vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.js")>();
  return { ...actual, setJoinViewFactory: vi.fn(actual.setJoinViewFactory) };
});
const session = await import("./session.js");

const LEAVE_ALT = "\x1b[?1049l";

function fakeTerminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn((_mode: boolean) => stdin),
  });
  let written = "";
  const stdout = {
    columns: 80,
    rows: 24,
    write: (text: string) => {
      written += text;
      return true;
    },
  };
  const hooks = new EventEmitter() as EventEmitter & ProcessHooks;
  return {
    stdin,
    stdout,
    hooks,
    output: () => written,
    frame(): string[] {
      const last = written.split("\x1b[H\x1b[2J").at(-1) ?? "";
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR/DEC escapes
      const sgr = /\x1b\[[0-9;?]*[a-zA-Z]/g;
      return last
        .replace(sgr, "")
        .split("\r\n")
        .map((l) => l.trimEnd());
    },
    rawModes: () => stdin.setRawMode.mock.calls.map(([mode]) => mode),
  };
}

/** `sleep` waits for {@link tick}; aborting rejects it, as the real clock does. */
function manualClock() {
  const waiters: (() => void)[] = [];
  const clock: Clock = {
    monotonicMs: () => 0,
    nowMs: () => 0,
    sleep: (_ms, signal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiters.push(resolve);
      }),
  };
  return {
    clock,
    sleeping: () => waiters.length,
    tick(): void {
      for (const wake of waiters.splice(0)) wake();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await flush();
  expect(cond()).toBe(true);
}

const SHA = "a".repeat(40);

function status(itemState: string, withResult = false): SessionStatus {
  return {
    sessionId: "s-1",
    listen: "192.0.2.10:7419",
    repo: "web",
    joinCode: null,
    joinCodeExpiresAtMs: null,
    peers: [
      {
        peerId: "peer-1",
        device: "laptop",
        address: "192.0.2.11",
        family: "IPv4",
        repo: "web",
        head: SHA,
        role: "coding",
      },
      {
        peerId: "peer-2",
        device: "desk",
        address: "192.0.2.12",
        family: "IPv4",
        repo: null,
        head: null,
        role: null,
      },
    ],
    intents: [
      {
        intentId: "N-1",
        text: "add a health check",
        state: "planned",
        items: [
          {
            itemId: "I-1",
            repo: "web",
            assignee: "peer-1",
            epoch: 1,
            title: "add a health check",
            datalistEntries: 0,
            state: itemState,
            ...(withResult
              ? {
                  result: {
                    itemId: "I-1",
                    epoch: 1,
                    repo: "web",
                    baseSha: SHA,
                    headSha: SHA,
                    checks: [],
                    summary: "submit pr opened https://example.com/org/web/pull/3\nagent exited 0",
                    submit: {
                      method: "pr",
                      state: "opened",
                      url: "https://example.com/org/web/pull/3",
                      number: 3,
                      branch: "skep/session/I-1-e1",
                    },
                  },
                }
              : {}),
          },
        ],
      },
    ],
  };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "skep-ui-"));
});
afterEach(async () => {
  session.setJoinViewFactory(null);
  vi.mocked(session.setJoinViewFactory).mockClear();
  await rm(home, { recursive: true, force: true });
});

function context(extra: Partial<UiCliContext> = {}) {
  let stdout = "";
  let stderr = "";
  const ctx: UiCliContext = {
    stdout: {
      write: (s: string) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s: string) => {
        stderr += s;
      },
    },
    env: { SKEP_HOME: home },
    output(): never {
      throw new Error("output() called before runCli bound it");
    },
    hostname: () => "hub",
    ...extra,
  };
  return { ctx, stdout: () => stdout, stderr: () => stderr };
}

describe("skep ui on a master", () => {
  it("shows status and per-item results, polls, and quits on q with the terminal restored", async () => {
    const term = fakeTerminal();
    const time = manualClock();
    const replies = [status("claimed"), status("done", true)];
    const uiStatus = vi.fn(async () => replies.shift() ?? status("done", true));
    const c = context({
      uiIo: { stdin: term.stdin, stdout: term.stdout },
      uiHooks: term.hooks,
      uiStatus,
      clock: time.clock,
    });
    const run = runCli(["ui"], c.ctx);
    await until(() => time.sleeping() === 1);
    let frame = term.frame();
    expect(frame[0]).toBe(" skep  session s-1  device hub  role master");
    expect(frame.slice(1, 4)).toEqual([
      "Peers",
      "> laptop  coding  I-1 e1  claimed",
      "  desk  -  joined",
    ]);
    expect(frame).toContain("Agent  runs on its device; item claimed");
    // Nothing to attach to or submit on the master.
    expect(frame[23]).toBe(" q quit");

    time.tick();
    await until(() => uiStatus.mock.calls.length === 2 && time.sleeping() === 1);
    frame = term.frame();
    expect(frame[2]).toBe("> laptop  coding  I-1 e1  done");
    expect(frame).toContain("Submit pr opened https://example.com/org/web/pull/3");
    expect(frame).toContain("  agent exited 0");

    term.stdin.write("q");
    await expect(run).resolves.toBe(0);
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(LEAVE_ALT)).toBe(true);
    expect(term.hooks.listenerCount("SIGINT")).toBe(0);
  });

  it("ends cleanly when the master goes away", async () => {
    const term = fakeTerminal();
    const time = manualClock();
    const { CliError } = await import("../output.js");
    let calls = 0;
    const c = context({
      uiIo: { stdin: term.stdin, stdout: term.stdout },
      uiHooks: term.hooks,
      uiStatus: async () => {
        calls += 1;
        if (calls === 1) return status("claimed");
        throw new CliError("session_unreachable", "connection refused");
      },
      clock: time.clock,
    });
    const run = runCli(["ui"], c.ctx);
    await until(() => time.sleeping() === 1);
    time.tick();
    await expect(run).resolves.toBe(0);
    expect(c.stderr()).toBe("session ended: connection refused\n");
    expect(term.rawModes()).toEqual([true, false]);
  });

  it("restores the terminal when a status read throws", async () => {
    const term = fakeTerminal();
    const time = manualClock();
    let calls = 0;
    const c = context({
      uiIo: { stdin: term.stdin, stdout: term.stdout },
      uiHooks: term.hooks,
      uiStatus: async () => {
        calls += 1;
        if (calls === 1) return status("claimed");
        throw new Error("malformed status");
      },
      clock: time.clock,
    });
    const run = runCli(["ui"], c.ctx);
    await until(() => time.sleeping() === 1);
    time.tick();
    await expect(run).resolves.toBe(1);
    expect(c.stderr()).toContain("malformed status");
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(LEAVE_ALT)).toBe(true);
  });

  it("SIGINT ends the view", async () => {
    const term = fakeTerminal();
    const time = manualClock();
    const c = context({
      uiIo: { stdin: term.stdin, stdout: term.stdout },
      uiHooks: term.hooks,
      uiStatus: async () => status("claimed"),
      clock: time.clock,
    });
    const run = runCli(["ui"], c.ctx);
    await until(() => time.sleeping() === 1);
    term.hooks.emit("SIGINT");
    await expect(run).resolves.toBe(0);
    expect(term.rawModes()).toEqual([true, false]);
  });

  it("without a local master, points a sub at session join --ui and never opens the screen", async () => {
    const term = fakeTerminal();
    const c = context({ uiIo: { stdin: term.stdin, stdout: term.stdout }, uiHooks: term.hooks });
    await expect(runCli(["ui"], c.ctx)).resolves.toBe(1);
    expect(c.stderr()).toContain("no session master runs on this device");
    expect(c.stderr()).toContain("skep session join --ui");
    expect(term.output()).toBe("");
  });

  it("rejects a malformed session.json", async () => {
    await writeFile(path.join(home, "session.json"), '{"listen":"x"}');
    const c = context();
    await expect(runCli(["ui"], c.ctx)).resolves.toBe(1);
    expect(c.stderr()).toContain("session.json is malformed");
  });
});

describe("masterSnapshot", () => {
  it("maps peers and items, keeping results as the tail and submit outcome", () => {
    const snap = masterSnapshot(status("done", true), "hub");
    expect(snap.header).toEqual({ session: "s-1", device: "hub", role: "master" });
    expect(snap.peers).toEqual([
      { peerId: "peer-1", device: "laptop", role: "coding", state: "repo web" },
      { peerId: "peer-2", device: "desk", role: "-", state: "joined" },
    ]);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toMatchObject({
      key: "I-1-e1",
      peerId: "peer-1",
      itemState: "done",
      agent: null,
      submit: { policy: "pr", outcome: { state: "opened" } },
    });
    expect(snap.entries[0]?.tail).toContain("agent exited 0");
  });
});

describe("session join --ui factory", () => {
  it("is registered only when the CLI owns the process terminal", () => {
    const setter = vi.mocked(session.setJoinViewFactory);
    buildProgram(context().ctx);
    expect(setter).not.toHaveBeenCalled();
    buildProgram({ ...context().ctx, stdout: process.stdout });
    expect(setter).toHaveBeenCalledOnce();
    expect(setter.mock.calls[0]?.[0]).toBeTypeOf("function");
  });

  it("builds the TUI, offers mr on a GitLab device, and a key quit raises SIGINT", async () => {
    await writeFile(path.join(home, "device.toml"), '[submit]\nmethod = "ask"\nhost = "gitlab"\n');
    const ctx = { ...context().ctx, paths: skepPaths(home) };
    const term = fakeTerminal();
    const view = joinViewFactory(ctx)({
      stdin: term.stdin as unknown as NodeJS.ReadStream,
      stdout: term.stdout as unknown as NodeJS.WriteStream,
    });
    const model = {
      peers: [{ peerId: "peer-1", device: "laptop", role: "coding", state: "joined" }],
      item: { itemId: "I-1", title: "fix", repo: "web", epoch: 1 },
      agent: { cli: "claude" as const, view: "pty" as const, state: "done" as const },
      tail: "",
      submit: { policy: "ask" as const },
    };
    view.update(model);
    const choice = view.chooseSubmit(model);
    await until(() => term.frame().includes("Submit p mr / u push / n none / s skip?"));
    term.stdin.write("p");
    await expect(choice).resolves.toBe("mr");

    const sigint = vi.fn();
    process.on("SIGINT", sigint);
    try {
      term.stdin.write("q");
      expect(sigint).toHaveBeenCalledOnce();
    } finally {
      process.off("SIGINT", sigint);
    }
    expect(term.rawModes()).toEqual([true, false]);
    view.close();
  });
});
