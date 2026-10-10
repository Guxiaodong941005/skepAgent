import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skepPaths } from "../../config/paths.js";
import type { Clock } from "../../util/clock.js";
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
        socket.end(encodeFrame(Buffer.from(JSON.stringify(answer))));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, requests };
}

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
  const masterClosed = deferred<void>();
  const subClosed = deferred<{ reason: string }>();
  const calls: { master: MasterOptions[]; sub: SubOptions[]; intents: string[] } = {
    master: [],
    sub: [],
    intents: [],
  };
  /** Peers the fake master reports in `status()`; tests push into it. */
  const peers: MasterPeer[] = [];
  let intentError: Error | null = null;
  let subError: Error | null = null;
  const api: SessionApi = {
    async startMaster(options): Promise<MasterHandle> {
      calls.master.push(options);
      options.onJoinCode({ code: "123456789012", expiresAtMs: 1_800_000_000_000 });
      return {
        address,
        sessionId: "S-1",
        status: () => ({
          sessionId: "S-1",
          listen: "192.168.1.20:7419",
          repo: "app",
          joinCode: "1234-5678-9012",
          joinCodeExpiresAtMs: null,
          peers: peers.map((peer) => ({ ...peer })),
          intents: [],
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
        closed: masterClosed.promise,
        close: async () => masterClosed.resolve(),
      };
    },
    async connectSub(options): Promise<SubHandle> {
      calls.sub.push(options);
      if (subError !== null) throw subError;
      return {
        sessionId: "S-1",
        peerId: "peer-1",
        fingerprint: "abcd-ef01-2345-6789",
        closed: subClosed.promise,
        close: async () => subClosed.resolve({ reason: "left" }),
      };
    },
  };
  return {
    api,
    calls,
    peers,
    failIntents(error: Error) {
      intentError = error;
    },
    failJoins(error: Error) {
      subError = error;
    },
    endSub(reason: string) {
      subClosed.resolve({ reason });
    },
  };
}

async function harness(
  masterAddress?: { host: string; port: number },
  prepare?: (dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-shell-"));
  roots.push(dir);
  await prepare?.(dir);
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
    expect(h.frame()).toContain("/join [<code>]");
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
    expect(h.scrollback()).toContain("/join 1234-5678-9012 --host 192.168.1.20:7419");
    expect(h.frame()).toContain("master · code 1234-5678-9012");
    expect(h.frame()).toContain("(no peers yet)");
    const written = JSON.parse(await readFile(path.join(h.dir, "session.json"), "utf8"));
    expect(written.listen).toBe("192.168.1.20:7419");
    await h.shell.quit();
    await h.running;
    await expect(readFile(path.join(h.dir, "session.json"), "utf8")).rejects.toThrow(/ENOENT/);
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
    expect(h.scrollback()).toContain("/join 1234-5678-9012 --host 192.168.1.20:7419");
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
    expect(h.scrollback()).toContain("it can rejoin with the current code: /join 1234-5678-9012");
    // Routine progress events never reach the scrollback.
    h.fake.calls.master[0]?.onEvent?.({ kind: "progress", message: "peer-2" });
    expect(h.scrollback()).not.toMatch(/^progress/m);
    await h.shell.quit();
  });

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
    expect(h.scrollback()).toContain("/join again with the master's current code");
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
  const held: (() => void)[] = [];
  let holding = false;
  let port = 0;
  const server = await controlServer(async (request) => {
    if (request.token !== accepted) {
      return { type: "control-result", ok: false, error: { code: "bad_token", message: "bad" } };
    }
    if (request.op !== "status") {
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
