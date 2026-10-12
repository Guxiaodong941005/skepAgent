import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skepHome, skepPaths } from "../../config/paths.js";
import { connectSub, ListenAddressError, startMaster } from "../../session/index.js";
import type { SessionStatus } from "../../session/messages.js";
import type { Clock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import {
  encodeFrame,
  FrameDecoder,
  type MasterHandle,
  type MasterOptions,
  type SessionApi,
  type SubHandle,
  type SubOptions,
} from "../commands/session.js";
import { parseFlags, Shell, type ShellCliContext } from "./run.js";

type MasterPeer = ReturnType<MasterHandle["status"]>["peers"][number];

const roots: string[] = [];
const servers: net.Server[] = [];
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A control port on loopback that answers every request with `reply(request)`. */
async function controlServer(
  reply: (request: { op?: string; token?: string }) => unknown,
): Promise<{ port: number; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      const [frame] = decoder.push(chunk);
      if (frame === undefined) return;
      const request = JSON.parse(frame.toString("utf8"));
      requests.push(request);
      void Promise.resolve(reply(request)).then((answer) => {
        if (answer === DROP) socket.destroy();
        else socket.end(encodeFrame(Buffer.from(JSON.stringify(answer))));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, requests };
}

/** A `controlServer` reply that closes the connection without answering (a lost reply). */
const DROP = Symbol("drop");

/** Never ticks: the shell's animation timer stays parked until it is aborted. */
const parkedClock: Clock = {
  monotonicMs: () => 0,
  nowMs: () => 0,
  sleep: (_ms, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
};

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(mode: boolean): void {
    this.raw.push(mode);
  }
  resume(): void {}
  pause(): void {}
  type(text: string): void {
    this.emit("data", Buffer.from(text, "utf8"));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fake session module: records options, never opens a socket. */
function fakeApi(address = { host: "192.168.1.20", port: 7419 }) {
  let masterClosed = deferred<void>();
  const subClosed = deferred<{ reason: string }>();
  const calls: { master: MasterOptions[]; sub: SubOptions[]; intents: string[] } = {
    master: [],
    sub: [],
    intents: [],
  };
  /** Peers the fake master reports in `status()`; tests push into it. */
  const peers: MasterPeer[] = [];
  /** Intents the fake master reports in `status()`; tests push into it. */
  const intents: SessionStatus["intents"] = [];
  let intentError: Error | null = null;
  let subError: Error | null = null;
  /** While set, `connectSub` waits for it: a join stuck in its handshake. */
  let subGate: Promise<void> | null = null;
  const subCloses: string[] = [];
  const api: SessionApi = {
    async startMaster(options): Promise<MasterHandle> {
      calls.master.push(options);
      // Each master closes on its own: a second /start must not inherit a closed promise.
      masterClosed = deferred<void>();
      const closed = masterClosed;
      options.onJoinCode({ code: "123456789012", expiresAtMs: 1_800_000_000_000 });
      return {
        address,
        sessionId: "S-1",
        status: () => ({
          sessionId: "S-1",
          listen: `${address.host}:${address.port}`,
          repo: "app",
          joinCode: "1234-5678-9012",
          joinCodeExpiresAtMs: null,
          peers: peers.map((peer) => ({ ...peer })),
          intents: intents.map((intent) => ({ ...intent })),
        }),
        submitIntent: async (text) => {
          calls.intents.push(text);
          if (intentError !== null) throw intentError;
          return { intentId: "N-1" };
        },
        presence: () => peers.map((peer) => ({ peerId: peer.peerId, silentMs: 25_000 })),
        attach: () => {
          throw new Error("fake master has no attach");
        },
        closed: closed.promise,
        close: async () => closed.resolve(),
      };
    },
    async connectSub(options): Promise<SubHandle> {
      calls.sub.push(options);
      if (subGate !== null) await subGate;
      if (subError !== null) throw subError;
      return {
        sessionId: "S-1",
        peerId: "peer-1",
        fingerprint: "abcd-ef01-2345-6789",
        closed: subClosed.promise,
        close: async () => {
          subCloses.push(options.code);
          subClosed.resolve({ reason: "left" });
        },
      };
    },
  };
  return {
    api,
    calls,
    peers,
    intents,
    failIntents(error: Error) {
      intentError = error;
    },
    failJoins(error: Error) {
      subError = error;
    },
    subCloses,
    /** Holds every join in its handshake until the returned function is called. */
    holdJoins(): () => void {
      const gate = deferred<void>();
      subGate = gate.promise;
      return () => {
        subGate = null;
        gate.resolve();
      };
    },
    endSub(reason: string) {
      subClosed.resolve({ reason });
    },
  };
}

async function harness(
  masterAddress?: { host: string; port: number },
  prepare?: (dir: string) => Promise<void> | Promise<Partial<ShellCliContext>>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-shell-"));
  roots.push(dir);
  // Only a stub agent and a logging git: a real agent CLI on this machine is never found.
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), '#!/bin/sh\necho "stub claude"\n', { mode: 0o755 });
  const realGit = (
    await execFileChecked("sh", ["-c", "command -v git"], { env: { PATH: process.env.PATH ?? "" } })
  ).stdout.trim();
  await writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf "%s\\n" "$*" >> "${path.join(dir, "git.log")}"\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const prepared = await prepare?.(dir);
  const stdin = new FakeStdin();
  let screen = "";
  const stderr: string[] = [];
  const fake = fakeApi(masterAddress);
  const ctx: ShellCliContext = {
    stdout: { write: () => {} },
    stderr: { write: (s) => void stderr.push(s) },
    env: {
      SKEP_HOME: dir,
      SKEP_TUI_GLYPHS: "ascii",
      SKEP_TUI_ANIMATE: "0",
      NO_COLOR: "1",
      HOME: dir,
      PATH: bin,
    },
    output: () => {
      throw new Error("the shell must not use the Commander output");
    },
    paths: skepPaths(dir),
    cwd: dir,
    sessionApi: fake.api,
    networkInterfaces: () => ({
      eth0: [
        {
          address: "192.168.1.20",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.20/24",
        },
      ],
    }),
    shellIo: {
      stdin,
      stdout: {
        isTTY: true,
        write: (text: string) => {
          screen += text;
        },
      },
      columns: 80,
      rows: 24,
    },
    shellHooks: { on: () => undefined, off: () => undefined },
    clock: parkedClock,
    hostname: () => "laptop",
    ...(prepared ?? {}),
  };
  const shell = new Shell(ctx);
  const running = shell.run();
  return {
    dir,
    shell,
    stdin,
    fake,
    stderr,
    running,
    /** The last full frame drawn, without escapes. */
    frame(): string {
      const at = screen.lastIndexOf("\x1b[H\x1b[2J");
      return (at < 0 ? screen : screen.slice(at)).replace(SGR, "");
    },
    get raw(): string {
      return screen;
    },
    scrollback(): string {
      return shell.model.scrollback.map((line) => line.text).join("\n");
    },
  };
}

describe("unified shell", () => {
  it("draws the welcome with the input box, and /quit restores the terminal", async () => {
    const h = await harness();
    expect(h.frame()).toContain("skep");
    expect(h.frame()).toMatch(/device\s+laptop/);
    expect(h.frame()).toContain("no session");
    expect(h.frame()).toContain("/start");
    expect(h.frame()).toContain("> _");
    h.stdin.type("/quit\r");
    await h.running;
    expect(h.raw.endsWith("\x1b[?1049l")).toBe(true);
    expect(h.stdin.raw).toEqual([true, false]);
  });

  it("opens the slash menu on / and filters it", async () => {
    const h = await harness();
    h.stdin.type("/jo");
    expect(h.shell.model.menu.map((command) => command.name)).toEqual(["join"]);
    expect(h.frame()).toContain("/join <code> <host:port> [--manual]");
    // Tab accepts with a trailing space because /join takes arguments.
    h.stdin.type("\t");
    expect(h.shell.model.input).toBe("/join ");
    expect(h.shell.model.menu).toEqual([]);
    h.stdin.type("\x1b");
    h.stdin.type("\x03");
    expect(h.shell.model.input).toBe("");
    await h.shell.quit();
  });

  it("reports an unknown command and hints at /start without a session", async () => {
    const h = await harness();
    await h.shell.submit("/nope");
    expect(h.scrollback()).toContain("unknown command: /nope — try /help");
    await h.shell.submit("refactor the auth middleware");
    expect(h.scrollback()).toContain("no session on this device — /start a master or /join one");
    await h.shell.quit();
  });

  it("/start runs a master in-process and prints the join code into the scrollback", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    expect(h.fake.calls.master).toHaveLength(1);
    expect(h.scrollback()).toContain("join code: 1234-5678-9012");
    expect(h.scrollback()).toContain("paste into skep: /join 1234-5678-9012 192.168.1.20:7419");
    expect(h.scrollback()).toContain(
      "skep session join --code 1234-5678-9012 --host 192.168.1.20:7419",
    );
    expect(h.scrollback()).not.toContain("peers dial");
    expect(h.frame()).toContain("master · code 1234-5678-9012");
    expect(h.frame()).toContain("(no peers yet)");
    const written = JSON.parse(await readFile(path.join(h.dir, "session.json"), "utf8"));
    expect(written.listen).toBe("192.168.1.20:7419");
    await h.shell.quit();
    await h.running;
    await expect(readFile(path.join(h.dir, "session.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("/start --advertise prints the address peers dial; the bind stays --listen", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app --advertise 203.0.113.7:7419");
    expect(h.scrollback()).toContain("session master listening on 192.168.1.20:7419 (repo app)");
    expect(h.scrollback()).toContain("peers dial 203.0.113.7:7419");
    expect(h.scrollback()).toContain("paste into skep: /join 1234-5678-9012 203.0.113.7:7419");
    // A rotated code comes with a fresh paste line on the advertise address.
    h.fake.calls.master[0]?.onJoinCode?.({ code: "999988887777", expiresAtMs: 0 });
    expect(h.scrollback()).toContain("paste: /join 9999-8888-7777 203.0.113.7:7419");
    await h.shell.quit();
  });

  it("/start auto-picks a free port for the paste line and /clean removes its pointer", async () => {
    const h = await harness({ host: "192.168.1.20", port: 7420 });
    const bind = h.fake.api.startMaster;
    const ports: number[] = [];
    h.fake.api.startMaster = async (options) => {
      ports.push(options.listen?.port ?? 0);
      if (options.listen?.port === 7419) {
        throw new ListenAddressError("Unable to bind session listener", {
          cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
        });
      }
      return bind(options);
    };
    try {
      await h.shell.submit("/start --yes --repo app");
      expect(ports).toEqual([7419, 7420]);
      expect(h.scrollback()).toContain("session master listening on 192.168.1.20:7420");
      expect(h.scrollback()).toContain("/join 1234-5678-9012 192.168.1.20:7420");
      h.fake.calls.master[0]?.onJoinCode?.({ code: "999988887777", expiresAtMs: 0 });
      expect(h.scrollback()).toContain("/join 9999-8888-7777 192.168.1.20:7420");
      await h.shell.submit("/clean");
      expect(h.shell.session.snapshot().mode).toBe("none");
      await expect(readFile(path.join(h.dir, "session.json"))).rejects.toThrow(/ENOENT/);
    } finally {
      await h.shell.quit();
    }
  });

  it("/start rejects a wildcard or malformed --advertise", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app --advertise 0.0.0.0:7419");
    expect(h.scrollback()).toContain("--advertise must name one interface address, not a wildcard");
    await h.shell.submit("/start --yes --repo app --advertise nope");
    expect(h.scrollback()).toContain("--advertise must be host:port, got nope");
    expect(h.fake.calls.master).toHaveLength(0);
    await h.shell.quit();
  });

  it("/start explains how to select an unused port after a bind collision", async () => {
    const h = await harness();
    h.fake.api.startMaster = async () => {
      throw new ListenAddressError("Unable to bind session listener", {
        cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
      });
    };
    try {
      await h.shell.submit("/start --yes --repo proj-b --listen 127.0.0.1:7420");
      expect(h.scrollback()).toContain("127.0.0.1:7420 is already in use");
      expect(h.scrollback()).toContain("--listen <host:unused-port>");
      expect(h.scrollback()).toContain("available ports automatically");
      expect(h.shell.session.snapshot().mode).toBe("none");
      await expect(readFile(path.join(h.dir, "session.json"))).rejects.toThrow(/ENOENT/);
    } finally {
      await h.shell.quit();
    }
  });

  it("/start never starts a master on a wildcard or blank --advertise host", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app --advertise *:7419");
    expect(h.scrollback()).toContain("--advertise must name one interface address, not a wildcard");
    await h.shell.submit('/start --yes --repo app --advertise " :7419"');
    expect(h.scrollback()).toContain('--advertise must name a hostname or IP address, got " "');
    await h.shell.submit("/start --yes --repo app --advertise [1:::2]:7419");
    expect(h.scrollback()).toContain('--advertise must name a hostname or IP address, got "1:::2"');
    await h.shell.submit("/start --yes --repo app --advertise [::%eth0]:7419");
    await h.shell.submit("/start --yes --repo app --advertise a..b:7419");
    expect(h.scrollback()).toContain('--advertise must name a hostname or IP address, got "a..b"');
    expect(h.scrollback().match(/not a wildcard/g)).toHaveLength(2);
    expect(h.fake.calls.master).toHaveLength(0);
    await h.shell.quit();
  });

  it("names a repo with spaces as prose and still takes it as a quoted --repo override", async () => {
    const h = await harness();
    await h.shell.submit('/start --yes --repo "my app"');
    // The repo is prose now; the paste line carries only the code and the host.
    expect(h.scrollback()).toContain(
      'from a checkout of "my app", paste into skep: /join 1234-5678-9012 192.168.1.20:7419',
    );
    const printed = h
      .scrollback()
      .split("\n")
      .filter((line) => !line.startsWith("> "));
    expect(printed.join("\n")).not.toContain("--repo");
    await h.shell.submit("/clean");
    await h.shell.submit('/join --host 192.168.1.20:7419 --code 1234-5678-9012 --repo "my app"');
    expect(h.fake.calls.sub[0]?.code).toBe("123456789012");
    expect(h.scrollback()).toContain("joined session S-1 at 192.168.1.20:7419 as peer-1");
    await h.shell.quit();
  });

  it("asks the human before accepting a join and takes the answer from the input", async () => {
    const h = await harness();
    await h.shell.submit("/start --repo app");
    const options = h.fake.calls.master[0];
    const accepted = options?.acceptJoin({
      device: "vps",
      address: "10.0.0.2",
      family: "IPv4",
      fingerprint: "ffff",
    });
    expect(h.shell.model.question).toContain("accept vps from 10.0.0.2");
    h.stdin.type("y\r");
    expect(await accepted).toBe(true);
    expect(h.shell.model.question).toBeNull();
    await h.shell.quit();
  });

  it("/join wires peer progress into bee strips under the input", async () => {
    const h = await harness();
    await h.shell.submit("/join 1234-5678-9012 --host 192.168.1.20:7419 --repo app");
    expect(h.fake.calls.sub).toHaveLength(1);
    expect(h.fake.calls.sub[0]?.code).toBe("123456789012");
    expect(h.scrollback()).toContain("joined session S-1 at 192.168.1.20:7419 as peer-1");
    h.fake.calls.sub[0]?.onProgress?.({
      peerId: "peer-2",
      device: "vps",
      role: "frontend",
      phase: "working",
      done: 1,
      total: 4,
      failed: 0,
      percent: 25,
      summary: "forms",
      self: false,
    });
    const lines = h.frame().split("\r\n");
    const input = lines.findIndex((line) => line.startsWith("> "));
    // The scrollback also logs the phase change; the strip is the last line naming the peer.
    const vps = lines.findLastIndex((line) => line.includes("vps") && line.includes("25%"));
    expect(input).toBeGreaterThan(0);
    expect(vps).toBeGreaterThan(input);
    expect(lines[vps]).toContain("forms");
    await h.shell.quit();
    await h.running;
    expect(h.scrollback()).toContain("left the session (left)");
  });

  it("sends free text as an intent to its own master once a peer joined", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.peers.push(peer("peer-1", "vps", "app"));
    await h.shell.submit("add a health check");
    expect(h.fake.calls.intents).toEqual(["add a health check"]);
    expect(h.scrollback()).toContain("intent N-1 routed: add a health check");
    await h.shell.quit();
  });

  it("refuses an intent while no peer joined, without recording it on the master", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    await h.shell.submit("/intent add a health check");
    expect(h.fake.calls.intents).toEqual([]);
    expect(h.scrollback()).toContain("no peers joined yet");
    expect(h.scrollback()).toMatch(
      /nothing can take this intent\n.*\/join 1234-5678-9012 192\.168\.1\.20:7419/,
    );
    await h.shell.quit();
  });

  it("explains a no_match by naming each peer's repo", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.peers.push(peer("peer-1", "vps", "api"));
    h.fake.failIntents(Object.assign(new Error("none"), { name: "NoMatchError" }));
    await h.shell.submit("add a health check");
    expect(h.scrollback()).toContain("no connected peer works on repo app (peer-1 vps: repo api)");
    await h.shell.quit();
  });

  it("shows presence on the master's footer and flags a quiet peer", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.peers.push(peer("peer-1", "vps", "app"));
    h.shell.sync();
    expect(h.frame()).toContain("quiet 25s");
    expect(h.frame()).toMatch(/peers 1/);
    await h.shell.quit();
  });

  it("logs a peer that left with its device, the reason and how to rejoin", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.calls.master[0]?.onEvent?.({
      kind: "left",
      message: "Peer peer-2 (mac) left: heartbeat_timeout",
    });
    expect(h.scrollback()).toContain(
      "Peer peer-2 (mac) left: heartbeat_timeout: no heartbeat for 30 s",
    );
    expect(h.scrollback()).toContain(
      "it can rejoin with the current code: /join 1234-5678-9012 192.168.1.20:7419",
    );
    // Routine progress events never reach the scrollback.
    h.fake.calls.master[0]?.onEvent?.({ kind: "progress", message: "peer-2" });
    expect(h.scrollback()).not.toMatch(/^progress/m);
    await h.shell.quit();
  });

  it("logs an accepted result's summary as an event and a rejected result as an error", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    const onEvent = h.fake.calls.master[0]?.onEvent;
    onEvent?.({ kind: "progress", message: "peer-2" });
    onEvent?.({ kind: "item-result", message: "I-4 done · mac (app)\n  added /healthz" });
    onEvent?.({ kind: "item-failed", message: "I-6 FAILED · mac (app)\n  cause: agent exited 3" });
    onEvent?.({ kind: "intent-done", message: "intent-1 done: x\n  1 done · 1 failed" });
    onEvent?.({ kind: "result-reject", message: "I-5: stale_epoch" });
    expect(h.scrollback()).toContain("I-4 done · mac (app)\n  added /healthz");
    expect(h.scrollback()).toContain("intent-1 done: x\n  1 done · 1 failed");
    const failed = h.shell.model.scrollback.find((line) => line.text.startsWith("I-6 FAILED"));
    expect(failed?.tone).toBe("error");
    expect(h.scrollback()).toContain("result rejected I-5: stale_epoch");
    expect(h.scrollback()).not.toMatch(/^progress/m);
    await h.shell.quit();
  });

  it.each(["own", "other process"])(
    "bare /join discovers the %s master in the same default project home",
    async (owner) => {
      let externalPort = 0;
      const external =
        owner === "other process"
          ? await controlServer(() => ({
              type: "control-result",
              ok: true,
              result: {
                sessionId: "S-1",
                listen: `127.0.0.1:${externalPort}`,
                repo: "app",
                joinCode: "123456789012",
                joinCodeExpiresAtMs: null,
                peers: [],
                intents: [],
              },
            }))
          : undefined;
      externalPort = external?.port ?? 0;
      let projectHome = "";
      const h = await harness(undefined, async (dir) => {
        const repo = path.join(dir, "app");
        const nested = path.join(repo, "src");
        await mkdir(nested, { recursive: true });
        const env = { HOME: dir, PATH: process.env.PATH, SKEP_TUI_ANIMATE: "0", NO_COLOR: "1" };
        await execFileChecked("git", ["init", "--quiet", repo]);
        projectHome = await skepHome(env, repo);
        expect(await skepHome(env, nested)).toBe(projectHome);
        if (external !== undefined) {
          await mkdir(projectHome, { recursive: true });
          await writeFile(
            path.join(projectHome, "session.json"),
            JSON.stringify({
              listen: `127.0.0.1:${external.port}`,
              token: "0".repeat(32),
            }),
          );
        }
        return { env, cwd: nested, paths: skepPaths(projectHome) };
      });
      try {
        if (owner === "own") await h.shell.submit("/start --yes");
        await h.shell.submit("/join");
        expect(h.fake.calls.sub).toHaveLength(1);
        expect(h.fake.calls.sub[0]?.code).toBe("123456789012");
        expect(h.fake.calls.sub[0]?.target).toEqual(
          external === undefined
            ? { host: "192.168.1.20", port: 7419 }
            : { host: "127.0.0.1", port: external.port },
        );
        expect(h.scrollback()).toContain("auto: master drives work; submit: none");
        await h.shell.submit("/clean");
        expect(h.fake.subCloses).toHaveLength(1);
        if (owner === "own") {
          await expect(readFile(path.join(projectHome, "session.json"))).rejects.toThrow(/ENOENT/);
        } else {
          expect(
            JSON.parse(await readFile(path.join(projectHome, "session.json"), "utf8")).listen,
          ).toBe(`127.0.0.1:${external?.port}`);
        }
      } finally {
        await h.shell.quit();
      }
    },
  );

  it("accepts /join <host:port> <code> and refuses free text on a peer", async () => {
    const h = await harness();
    await h.shell.submit("/join 192.168.30.182:7419 8632-1727-0308 --repo app");
    expect(h.fake.calls.sub[0]?.code).toBe("863217270308");
    expect(h.fake.calls.sub[0]?.target).toEqual({ host: "192.168.30.182", port: 7419 });
    expect(h.frame()).toContain("joined 192.168.30.182:7419 as peer-1");
    await h.shell.submit("add a health check");
    expect(h.scrollback()).toContain("this device is a peer of 192.168.30.182:7419");
    await h.shell.submit("/status");
    expect(h.scrollback()).toContain("joined 192.168.30.182:7419 as peer-1 (role coding)");
    await h.shell.quit();
  });

  it("keeps peer-2 joined after an intent with the same device name and a non-git cwd", async () => {
    const master = await startMaster({
      device: "mac",
      repo: "proj-a",
      controlToken: "0".repeat(32),
      acceptJoin: async () => true,
      onJoinCode: () => {},
    });
    const connectPeer: SessionApi["connectSub"] = ({ target: _target, ...options }) => {
      const toMaster = new PassThrough();
      const toPeer = new PassThrough();
      master.attach(Duplex.from({ readable: toMaster, writable: toPeer }), {
        address: "127.0.0.1",
        family: "IPv4",
      });
      return connectSub({
        ...options,
        stream: Duplex.from({ readable: toPeer, writable: toMaster }),
        progressIntervalMs: 0,
      });
    };
    let first: SubHandle | undefined;
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      const code = master.status().joinCode;
      if (code === null) throw new Error("master has no join code");
      first = await connectPeer({
        code,
        device: "mac",
        describe: async () => ({ repo: "proj-c", role: "coding", head: "a".repeat(40) }),
        collectDatalist: async () => [],
        onItem: async () => null,
      });
      h = await harness(undefined, async (dir) => {
        const peerDir = path.join(dir, "proj-b");
        await mkdir(peerDir);
        return { cwd: peerDir, sessionApi: { startMaster, connectSub: connectPeer } };
      });
      const peer = h;
      const currentCode = master.status().joinCode;
      if (currentCode === null) throw new Error("master has no join code");
      await peer.shell.submit(
        `/join --host example.com:7419 --code ${currentCode} --repo proj-a --device mac`,
      );
      expect(peer.shell.session.snapshot().join?.peerId).toBe("peer-2");
      await peer.shell.submit("add a health check");
      expect(peer.scrollback()).toContain("type intents in the master's shell");
      await expect(master.submitIntent("add a health check")).resolves.toEqual({
        intentId: "intent-1",
      });
      await vi.waitFor(() => expect(master.status().intents[0]?.items[0]?.state).toBe("done"));
      expect(master.status().peers).toHaveLength(2);
      expect(master.status().intents[0]?.items[0]).toMatchObject({
        assignee: "peer-2",
        datalistEntries: 0,
        // A non-git folder now runs the agent in place; this stub changes nothing.
        result: {
          checks: [{ name: "none", status: "skip" }],
          submit: { method: "none", state: "skipped" },
        },
      });
      expect(master.status().intents[0]?.items[0]?.result?.summary).toContain("\nno changes");
      expect(peer.scrollback()).toContain(
        `agent: claude (found on PATH) · mode: edits this folder directly (${path.join(peer.dir, "proj-b")})`,
      );
      expect(peer.shell.session.snapshot().mode).toBe("joined");
      expect(peer.scrollback()).toContain("cannot read this directory's Git HEAD");
      expect(peer.scrollback()).toContain("sending an empty datalist");
      expect(peer.scrollback()).not.toContain("callback_error");
      expect(peer.scrollback()).not.toContain("left the session");
    } finally {
      await h?.shell.quit();
      await first?.close();
      await master.close();
    }
  });

  it("joins with just the slim paste: repo and device come from the checkout and hostname", async () => {
    const hostname = vi.spyOn(os, "hostname").mockReturnValue("Kris-MacBook.local");
    let checkout = "";
    const h = await harness(undefined, async (dir) => {
      checkout = path.join(dir, "my-repo");
      await mkdir(checkout);
      await execFileChecked("git", ["init", "--quiet", checkout]);
      return { cwd: checkout };
    });
    try {
      await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419");
      const sub = h.fake.calls.sub[0];
      expect(sub?.code).toBe("123456789012");
      expect(sub?.target).toEqual({ host: "192.168.1.20", port: 7419 });
      expect(sub?.device).toBe("kris-macbook-local");
      expect((await sub?.describe())?.repo).toBe("my-repo");
    } finally {
      hostname.mockRestore();
      await h.shell.quit();
    }
  });

  it("joins in auto mode by default and says so; --manual opts out", async () => {
    const h = await harness();
    await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419 --repo app");
    expect(h.scrollback()).toContain("as peer-1 (auto: master drives work; submit: none)");
    await h.shell.submit("/clean");
    await h.shell.submit(
      "/join 1234-5678-9012 192.168.1.20:7419 --repo app --manual --submit none",
    );
    expect(h.scrollback()).toContain(
      "as peer-1 (manual: you confirm each item before it runs; submit: none)",
    );
    await h.shell.quit();
  });

  it("/clean drops manual item questions, also the one queued behind the first", async () => {
    const h = await harness();
    await h.shell.submit(
      "/join 1234-5678-9012 192.168.1.20:7419 --repo app --manual --submit none",
    );
    const sub = h.fake.calls.sub[0];
    if (sub === undefined) throw new Error("no join");
    const item = (n: number) => ({
      itemId: `I-${n}`,
      repo: "app",
      assignee: "peer-1",
      epoch: 1,
      title: `item ${n}`,
      datalistEntries: 0,
    });
    const first = sub.onItem(item(1));
    const second = sub.onItem(item(2));
    await vi.waitFor(() => expect(h.shell.model.question).toContain("Run item I-1"));
    await h.shell.submit("/clean");
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result?.checks).toEqual([{ name: "peer", status: "skip" }]);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.shell.model.question).toBeNull();
    expect(h.scrollback()).not.toContain("Run item I-2");
    expect(h.shell.model.header.session).toBe("no session");
    // The next command runs as a command, not as an answer to a stale question.
    await h.shell.submit("/help");
    expect(h.scrollback()).toMatch(/\/clean\s+end local session/);
    await h.shell.quit();
  });

  it("rejects a malformed /join with the accepted forms", async () => {
    const h = await harness();
    await h.shell.submit("/join 192.168.30.182:7419 nope");
    expect(h.fake.calls.sub).toHaveLength(0);
    expect(h.scrollback()).toContain("/join: nope is neither a 12-digit join code nor host:port");
    expect(h.scrollback()).toContain("/join <host:port> <NNNN-NNNN-NNNN>");
    await h.shell.quit();
  });

  it("drops the peer strip and says why when the join ends, ignoring late rosters", async () => {
    const h = await harness();
    await h.shell.submit("/join 1234-5678-9012 --host 192.168.1.20:7419 --repo app");
    const sub = h.fake.calls.sub[0];
    const vps = {
      peerId: "peer-2",
      device: "vps",
      role: "frontend",
      phase: "idle" as const,
      done: 0,
      total: 0,
      failed: 0,
      percent: 0,
      summary: "",
      self: false,
    };
    sub?.onProgress?.(vps);
    expect(h.shell.model.peers.map((p) => p.peerId)).toContain("peer-2");
    h.fake.endSub("heartbeat_timeout");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.scrollback()).toContain("left the session (heartbeat_timeout: no heartbeat for 30 s");
    expect(h.scrollback()).toContain("ask the master for its current code");
    expect(h.scrollback()).toContain("/join <code> 192.168.1.20:7419");
    expect(h.shell.model.peers).toEqual([]);
    expect(h.shell.model.header.session).toBe("no session");
    // A late relay from the dead flow must not bring the row back.
    sub?.onProgress?.({ ...vps, phase: "working" });
    expect(h.shell.model.peers).toEqual([]);
    expect(h.frame()).not.toMatch(/vps\s+frontend/);
    await h.shell.quit();
  });

  it("attaches to a master running in another process on this device", async () => {
    const status = {
      sessionId: "S-9",
      listen: "127.0.0.1:7419",
      repo: "app",
      joinCode: "111122223333",
      joinCodeExpiresAtMs: null,
      peers: [
        {
          peerId: "peer-2",
          device: "mac",
          address: "192.168.1.30",
          family: "IPv4",
          repo: "app",
          head: null,
          role: "coding",
          progress: {
            phase: "idle",
            done: 0,
            total: 0,
            failed: 0,
            percent: 0,
            summary: "",
          },
        },
      ],
      intents: [],
    };
    const control = await controlServer((request) =>
      request.op === "status"
        ? { type: "control-result", ok: true, result: status }
        : { type: "control-result", ok: true, result: { intentId: "N-7" } },
    );
    const h = await harness(undefined, async (dir) => {
      const token = "0".repeat(32);
      await writeFile(
        path.join(dir, "session.json"),
        `${JSON.stringify({ listen: `127.0.0.1:${control.port}`, token })}\n`,
      );
    });
    await waitFor(() => h.shell.model.sessionLive);
    expect(h.frame()).toContain("master (other process) · code 1111-2222-3333");
    expect(h.frame()).toMatch(/mac\s+coding/);
    await h.shell.submit("add a health check");
    expect(control.requests).toContainEqual(
      expect.objectContaining({ op: "intent", text: "add a health check" }),
    );
    expect(h.scrollback()).toContain("intent N-7 routed: add a health check");
    await h.shell.quit();
  });
});

/**
 * A master in another process: a loopback control port that checks its own token (a replacement
 * master never accepts an old one), answers `status` and `intent`, and can hold `status` replies.
 */
async function externalMaster(id: string, repo: string) {
  const token = id.toLowerCase().repeat(32).slice(0, 32);
  let accepted = token;
  let dropIntentReplies = false;
  const held: (() => void)[] = [];
  let holding = false;
  let port = 0;
  const server = await controlServer(async (request) => {
    if (request.token !== accepted) {
      return { type: "control-result", ok: false, error: { code: "bad_token", message: "bad" } };
    }
    if (request.op !== "status") {
      // The request was received (and recorded) before the reply is lost: it took effect.
      if (dropIntentReplies) return DROP;
      return { type: "control-result", ok: true, result: { intentId: `${id}-intent-1` } };
    }
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    const result = {
      sessionId: `session-${id}`,
      listen: `127.0.0.1:${port}`,
      repo,
      joinCode: "111122223333",
      joinCodeExpiresAtMs: null,
      peers: [{ ...peer("peer-2", "mac", repo), progress: undefined }],
      intents: [],
    };
    return { type: "control-result", ok: true, result };
  });
  port = server.port;
  return {
    ...server,
    /** Writes this master into the shell's `session.json`. */
    publish: (dir: string) =>
      writeFile(
        path.join(dir, "session.json"),
        `${JSON.stringify({ listen: `127.0.0.1:${port}`, token })}\n`,
      ),
    hold() {
      holding = true;
    },
    /** Intents are accepted, but their replies never arrive. */
    dropReplies() {
      dropIntentReplies = true;
    },
    /** Another master took this port and has not published its file yet. */
    retoken() {
      accepted = "f".repeat(32);
    },
    release() {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
    intents: () => server.requests.filter((r) => (r as { op?: string }).op === "intent"),
  };
}

function peer(peerId: string, device: string, repo: string): MasterPeer {
  return {
    peerId,
    device,
    address: "10.0.0.2",
    family: "IPv4",
    repo,
    head: null,
    role: "coding",
    progress: { phase: "idle", done: 0, total: 0, failed: 0, percent: 0, summary: "" },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("external master identity and discovery (review B1-B3)", () => {
  it.each(["", " --listen 127.0.0.1:7420"])(
    "/start with a shared home explains overrides and preserves the live master (%j)",
    async (listenFlag) => {
      const a = await externalMaster("A", "proj-a");
      const h = await harness(undefined, a.publish);
      try {
        await waitFor(() => h.shell.session.externalStatus !== null);
        const file = path.join(h.dir, "session.json");
        const before = await readFile(file, "utf8");
        await h.shell.submit(`/start --yes --repo proj-b${listenFlag}`);
        expect(h.scrollback()).toContain("one session per home");
        expect(h.scrollback()).toContain("skep --home <separate-dir>");
        expect(h.scrollback()).toContain("omit the override");
        expect(h.scrollback()).toContain("ports automatically");
        expect(h.fake.calls.master).toHaveLength(0);
        expect(h.shell.session.snapshot().mode).toBe("external");
        expect(h.shell.session.externalStatus?.repo).toBe("proj-a");
        expect(await readFile(file, "utf8")).toBe(before);
        expect(a.intents()).toEqual([]);
      } finally {
        await h.shell.quit();
      }
    },
  );

  it("never sends an intent to a replacement master while showing the old one", async () => {
    const a = await externalMaster("A", "app-a");
    const b = await externalMaster("B", "app-b");
    const h = await harness(undefined, a.publish);
    await waitFor(() => h.shell.session.externalStatus !== null);
    expect(h.shell.session.externalStatus?.sessionId).toBe("session-A");
    // Master A is replaced by B before the next poll.
    await b.publish(h.dir);
    await h.shell.submit("add a health check");
    expect(a.intents()).toEqual([]);
    expect(b.intents()).toEqual([]);
    expect(h.scrollback()).toContain("the session master on this device changed (was session-A");
    expect(h.scrollback()).toContain("the intent was not sent");
    expect(h.scrollback()).toContain("now showing session-B");
    // The shell now shows B, so a resent intent goes to B on purpose.
    expect(h.shell.session.externalStatus?.repo).toBe("app-b");
    await h.shell.submit("add a health check");
    expect(b.intents()).toHaveLength(1);
    expect(h.scrollback()).toContain("intent B-intent-1 routed");
    await h.shell.quit();
  });

  it("rejects an intent when the shown master's endpoint stopped accepting its token", async () => {
    const a = await externalMaster("A", "app");
    const h = await harness(undefined, a.publish);
    await waitFor(() => h.shell.session.externalStatus !== null);
    a.retoken();
    await h.shell.submit("add a health check");
    expect(h.scrollback()).toContain("the intent was not sent");
    expect(h.scrollback()).toContain("no session master runs on this device now");
    expect(h.shell.session.snapshot().mode).toBe("none");
    await h.shell.quit();
  });

  it("says an intent may have been accepted when its reply is lost, without inviting a resend", async () => {
    const a = await externalMaster("A", "app");
    const h = await harness(undefined, a.publish);
    await waitFor(() => h.shell.session.externalStatus !== null);
    a.dropReplies();
    await h.shell.submit("add a health check");
    // The master received the intent: it may well be planned there.
    expect(a.intents()).toHaveLength(1);
    const out = h.scrollback();
    expect(out).toContain("no reply after the intent was sent — it may have been accepted");
    expect(out).toContain("the master is still session-A");
    expect(out).toContain("/status lists its intents");
    expect(out).toContain("sending it again could start the same work twice");
    expect(out).not.toContain("not sent");
    expect(out).not.toContain("changed");
    expect(out).not.toMatch(/\bresend\b/);
    // Identity is unchanged, so the shell still shows (and stays bound to) the same master.
    expect(h.shell.session.snapshot().mode).toBe("external");
    expect(h.shell.session.externalStatus?.sessionId).toBe("session-A");
    await h.shell.quit();
  });

  it("re-discovers the external master after a failed self-join", async () => {
    const a = await externalMaster("A", "app");
    const h = await harness(undefined, a.publish);
    await waitFor(() => h.shell.session.externalStatus !== null);
    h.fake.failJoins(new Error("join rejected: declined"));
    await h.shell.submit("/join --repo app");
    expect(h.scrollback()).toContain("join rejected: declined");
    await waitFor(() => h.shell.session.snapshot().mode === "external");
    expect(h.frame()).toContain("master (other process)");
    await h.shell.submit("add a health check");
    expect(a.intents()).toHaveLength(1);
    await h.shell.quit();
  });

  it("re-discovers the external master after a self-join disconnects", async () => {
    const a = await externalMaster("A", "app");
    const h = await harness(undefined, a.publish);
    await waitFor(() => h.shell.session.externalStatus !== null);
    await h.shell.submit("/join --repo app");
    expect(h.shell.session.snapshot().mode).toBe("joined");
    h.fake.endSub("heartbeat_timeout");
    await waitFor(() => h.shell.session.snapshot().mode === "external");
    expect(h.shell.model.header.session).toContain("master (other process)");
    await h.shell.quit();
  });

  it("drops a discovery that completes after /start", async () => {
    const a = await externalMaster("A", "app");
    a.hold();
    const h = await harness(undefined, a.publish);
    await waitFor(() => a.requests.length > 0);
    // The startup probe is still waiting for A's reply; A stops publishing so /start may run.
    await rm(path.join(h.dir, "session.json"));
    await h.shell.submit("/start --yes --repo app");
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.shell.session.snapshot().mode).toBe("master");
    expect(h.frame()).toContain("master · code 1234-5678-9012");
    await h.shell.quit();
  });
});

describe("parseFlags", () => {
  it("reads values, switches and positionals", () => {
    const flags = parseFlags("1234 --host=h:1 --role web --yes", ["host", "role"], ["yes"]);
    expect(flags.positional).toEqual(["1234"]);
    expect(flags.values).toEqual({ host: "h:1", role: "web" });
    expect([...flags.switches]).toEqual(["yes"]);
  });

  it("rejects unknown options and a missing value", () => {
    expect(() => parseFlags("--nope", [], [])).toThrow(/unknown option --nope/);
    expect(() => parseFlags("--host", ["host"], [])).toThrow(/--host needs a value/);
  });
});

describe("/clean", () => {
  it("is listed in /help and in the slash menu without a session", async () => {
    const h = await harness();
    h.stdin.type("/cl");
    expect(h.shell.model.menu.map((command) => command.name)).toEqual(["clean"]);
    h.stdin.type("\x1b");
    h.stdin.type("\x03");
    await h.shell.submit("/help");
    expect(h.scrollback()).toMatch(/\/clean\s+end local session\(s\) and clear connection state/);
    await h.shell.quit();
  });

  it("is a no-op without a session and keeps the shell open", async () => {
    const h = await harness();
    await h.shell.submit("/clean");
    expect(h.scrollback()).toContain("nothing to clean — no session on this device");
    expect(h.shell.model.scrollback.some((line) => line.tone === "error")).toBe(false);
    expect(h.raw.endsWith("\x1b[?1049l")).toBe(false);
    await h.shell.quit();
  });

  it("stops the shell's master, removes session.json and lets /start run again", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.peers.push(peer("peer-1", "vps", "app"));
    h.shell.sync();
    expect(h.shell.model.peers).toHaveLength(1);
    await h.shell.submit("/clear");
    expect(h.scrollback()).toContain("cleared: stopped master on 192.168.1.20:7419 — session idle");
    expect(h.shell.session.snapshot().mode).toBe("none");
    expect(h.shell.model.sessionLive).toBe(false);
    expect(h.shell.model.peers).toEqual([]);
    expect(h.frame()).toContain("no session");
    await expect(readFile(path.join(h.dir, "session.json"), "utf8")).rejects.toThrow(/ENOENT/);
    await h.shell.submit("/status");
    expect(h.scrollback()).toContain("no session on this device — /start a master or /join one");
    await h.shell.submit("/start --yes --repo app");
    expect(h.fake.calls.master).toHaveLength(2);
    expect(h.shell.session.snapshot().mode).toBe("master");
    await h.shell.quit();
  });

  it("leaves the shell's join and drops its peer strip", async () => {
    const h = await harness();
    await h.shell.submit("/join 1234-5678-9012 --host 192.168.1.20:7419 --repo app");
    expect(h.scrollback()).not.toContain("/quit to leave");
    await h.shell.submit("/join 1234-5678-9012 --host 192.168.1.20:7419");
    expect(h.scrollback()).toContain("/clean leaves the session, /quit leaves the shell");
    h.fake.calls.sub[0]?.onProgress?.({
      peerId: "peer-2",
      device: "vps",
      role: "frontend",
      phase: "working",
      done: 1,
      total: 4,
      failed: 0,
      percent: 25,
      summary: "forms",
      self: false,
    });
    expect(h.shell.model.peers.map((p) => p.peerId)).toContain("peer-2");
    await h.shell.submit("/clean");
    expect(h.fake.subCloses).toEqual(["123456789012"]);
    expect(h.scrollback()).toContain("cleared: left 192.168.1.20:7419 as peer-1 — session idle");
    expect(h.shell.session.snapshot().mode).toBe("none");
    expect(h.shell.model.peers).toEqual([]);
    await h.shell.quit();
  });

  it("cancels a join stuck in its handshake and frees the command queue (review B2)", async () => {
    const h = await harness();
    const release = h.fake.holdJoins();
    const joining = h.shell.submit("/join 1234-5678-9012 --host 192.168.1.20:7419 --repo app");
    await waitFor(() => h.fake.calls.sub.length === 1);
    expect(h.shell.session.snapshot().mode).toBe("joining");
    await h.shell.submit("/clean");
    expect(h.scrollback()).toContain("cleared: cancelled join of 192.168.1.20:7419");
    expect(h.shell.session.snapshot().mode).toBe("none");
    // The old handshake is still held: the queued /join must have let go anyway.
    await joining;
    await h.shell.submit("/help");
    expect(h.scrollback()).toMatch(/\/status\s+show peers/);
    await h.shell.submit("/start --yes --repo app");
    expect(h.shell.session.snapshot().mode).toBe("master");
    const before = h.scrollback();
    // The handshake finishing late is closed and cannot touch the new master or the screen.
    release();
    await waitFor(() => h.fake.subCloses.length === 1);
    expect(h.shell.session.snapshot().mode).toBe("master");
    expect(h.shell.session.ownJoin).toBeNull();
    expect(h.scrollback().slice(before.length)).not.toContain("joined session");
    await h.shell.quit();
  });

  it("runs at a pending prompt, answering every question with no answer (review B1)", async () => {
    const h = await harness();
    await h.shell.submit("/start --repo app");
    const accepted = h.fake.calls.master[0]?.acceptJoin({
      device: "vps",
      address: "10.0.0.2",
      family: "IPv4",
      fingerprint: "ffff",
    });
    const submitChoice = h.shell.ask("submit this item? [pr/mr/push/none/skip]");
    expect(h.shell.model.question).toContain("accept vps from 10.0.0.2");
    h.stdin.type("/clean\r");
    expect(await accepted).toBe(false);
    expect(await submitChoice).toBeNull();
    await waitFor(() => h.scrollback().includes("cleared: stopped master"));
    expect(h.shell.model.question).toBeNull();
    expect(h.shell.session.snapshot().mode).toBe("none");
    await expect(readFile(path.join(h.dir, "session.json"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(h.raw.endsWith("\x1b[?1049l")).toBe(false);
    await h.shell.submit("/status");
    expect(h.scrollback()).toContain("no session on this device");
    await h.shell.quit();
  });

  it("removes a session.json whose master is gone", async () => {
    const dead = net.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const { port } = dead.address() as net.AddressInfo;
    await new Promise((resolve) => dead.close(resolve));
    const h = await harness(undefined, (dir) =>
      writeFile(
        path.join(dir, "session.json"),
        `${JSON.stringify({ listen: `127.0.0.1:${port}`, token: "0".repeat(32) })}\n`,
      ),
    );
    await h.shell.submit("/clean");
    expect(h.scrollback()).toContain(
      `cleared: removed stale session.json (master at 127.0.0.1:${port} gone) — session idle`,
    );
    await expect(readFile(path.join(h.dir, "session.json"), "utf8")).rejects.toThrow(/ENOENT/);
    await h.shell.quit();
  });

  it("never stops a live master in another process and keeps showing it", async () => {
    const other = await externalMaster("A", "app");
    const h = await harness(undefined, other.publish);
    await waitFor(() => h.shell.session.snapshot().mode === "external");
    await h.shell.submit("/clean");
    expect(h.scrollback()).toContain(
      `a session master in another process still runs at 127.0.0.1:${other.port}`,
    );
    expect(h.shell.session.snapshot().mode).toBe("external");
    expect(await readFile(path.join(h.dir, "session.json"), "utf8")).toContain(`${other.port}`);
    await h.shell.quit();
  });
});

describe("SESSION-UX shell copy", () => {
  it("/join names the agent, says it edits the folder, and /clean leaves nothing on disk", async () => {
    const h = await harness();
    await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419 --repo app");
    expect(h.scrollback()).toContain(
      `agent: claude (found on PATH) · mode: edits this folder directly (${h.dir})`,
    );
    const log = path.join(h.dir, "git.log");
    const before = await readFile(log, "utf8").catch(() => "");
    await h.shell.submit("/clean");
    expect(h.scrollback()).toContain(
      "nothing left on disk: no worktrees or session branches; edits stay in your folder",
    );
    // /clean only ends connection state: it never runs git.
    expect(await readFile(log, "utf8").catch(() => "")).toBe(before);
    await h.shell.quit();
  });

  it("a /join without any agent fails with one cause and one fix, and stays unjoined", async () => {
    const h = await harness();
    await rm(path.join(h.dir, "bin", "claude"));
    await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419 --repo app");
    expect(h.scrollback()).toContain(
      "join failed: no agent CLI found (looked for claude, codex, pi on PATH)\n" +
        "fix: install one, or pass --agent <claude|codex|pi> (in the skep shell: /agent <cli>)",
    );
    expect(h.scrollback()).toContain(`full text: ${path.join(h.dir, "session", "last-error.log")}`);
    expect(h.fake.calls.sub).toHaveLength(0);
    expect(h.shell.session.snapshot().mode).toBe("none");
    await h.shell.quit();
  });

  it("/agent persists the CLI in device.toml and the next /join uses it", async () => {
    const h = await harness();
    await h.shell.submit("/agent");
    expect(h.scrollback()).toContain("agent: not set; /join uses --agent, SKEP_AGENT_CLI");
    await h.shell.submit("/agent codex");
    const toml = path.join(h.dir, "device.toml");
    expect(h.scrollback()).toContain(`session items will run codex; saved in ${toml}`);
    expect(await readFile(toml, "utf8")).toBe('[agent]\ncli = "codex"\n');
    await h.shell.submit("/agent");
    expect(h.scrollback()).toContain(`agent: codex (saved in ${toml})`);
    await writeFile(path.join(h.dir, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
    await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419 --repo app");
    expect(h.scrollback()).toContain("agent: codex (from /agent) · mode: edits this folder");
    await h.shell.submit("/clean");
    // The pre-SESSION-UX spelling is refused with its replacement.
    await h.shell.submit("/join 1234-5678-9012 192.168.1.20:7419 --agent pty");
    expect(h.scrollback()).toContain("--agent pty is now --view pty");
    await h.shell.quit();
  });

  it("/undo refuses an unknown item with where it looked", async () => {
    const h = await harness();
    await h.shell.submit("/undo I-4");
    expect(h.scrollback()).toContain("no recorded changes for I-4 in this project");
    await h.shell.submit("/undo");
    expect(h.scrollback()).toContain("usage: /undo <item> [--force]");
    await h.shell.quit();
  });
});

describe("long results in the shell (SESSION-UX R7, R8)", () => {
  function frameText(h: Awaited<ReturnType<typeof harness>>, columns: number, rows: number) {
    return h.shell.model
      .frame(columns, rows)
      .map((line) => (typeof line === "string" ? line : line.spans.map((s) => s.text).join("")))
      .join("\n");
  }

  it("PgUp reaches the first word of an error longer than the body", async () => {
    const h = await harness();
    const words = Array.from({ length: 500 }, (_, n) => `e${String(n).padStart(3, "0")}`);
    h.shell.log(words.join(" "), "error");
    h.shell.log("a later info line");
    const seen = new Set<string>();
    const collect = () => {
      const shown = frameText(h, 80, 24).match(/e\d{3}/g) ?? [];
      // A frame never shows a word twice.
      expect(new Set(shown).size).toBe(shown.length);
      for (const word of shown) seen.add(word);
    };
    collect();
    for (let i = 0; i < 100 && !seen.has("e000"); i++) {
      h.stdin.type("\x1b[5~");
      collect();
    }
    // Every word was on screen at some point, in order.
    expect([...seen].sort()).toEqual(words);
    // Further PgUp stays at the start; PgDn comes back to the bottom.
    h.stdin.type("\x1b[5~");
    expect(frameText(h, 80, 24)).toContain("e000");
    for (let i = 0; i < 100 && h.shell.model.scroll > 0; i++) h.stdin.type("\x1b[6~");
    expect(frameText(h, 80, 24)).toContain("a later info line");
    expect(frameText(h, 80, 24)).toContain("e499");
    await h.shell.quit();
  });

  it("/status wraps a long failed cause and a success summary over 600 characters", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    h.fake.peers.push(peer("peer-1", "vps", "app"));
    const cause = Array.from({ length: 70 }, (_, n) => `c${String(n).padStart(2, "0")}`);
    const said = Array.from({ length: 120 }, (_, n) => `s${String(n).padStart(3, "0")}`);
    const item = (itemId: string, summary: string, check: "pass" | "fail") => ({
      itemId,
      repo: "app",
      assignee: "peer-1",
      epoch: 1,
      title: "t",
      datalistEntries: 0,
      state: "done" as const,
      result: {
        itemId,
        epoch: 1,
        repo: "app",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        checks: [{ name: "agent", status: check }],
        submit: { method: "none" as const, state: "local" as const, branch: "main" },
        summary,
      },
    });
    const ok = [
      "submit none local",
      "done · claude · 3s",
      ...Array.from({ length: 12 }, (_, n) => `line ${n} ${"x".repeat(40)}`),
      `summary: ${said.join(" ")}`,
    ].join("\n");
    expect(ok.length).toBeGreaterThan(600);
    h.fake.intents.push({
      intentId: "intent-1",
      text: "ship it",
      state: "planned",
      items: [
        item("I-1", `submit none local\nFAILED · claude · 1s\ncause: ${cause.join(" ")}`, "fail"),
        item("I-2", ok, "pass"),
      ],
    });
    await h.shell.submit("/status");
    const failed = h.shell.model.scrollback.find((e) => e.text.includes("I-1 FAILED"));
    const done = h.shell.model.scrollback.find((e) => e.text.includes("I-2 done"));
    expect(failed?.tone).toBe("error");
    expect(done?.tone).toBe("warn");
    const frame = frameText(h, 80, 400);
    expect(frame.match(/c\d{2}/g)).toEqual(cause);
    expect(frame.match(/s\d{3}/g)).toEqual(said);
    expect(frame).toContain("line 11");
    for (const row of frame.split("\n")) expect(row.length).toBeLessThanOrEqual(80);
    await h.shell.quit();
  });
});
