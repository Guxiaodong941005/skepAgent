import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const roots: string[] = [];
const servers: net.Server[] = [];
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A control port on loopback that answers every request with `reply`. */
async function controlServer(reply: unknown): Promise<{ port: number; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      const [frame] = decoder.push(chunk);
      if (frame === undefined) return;
      requests.push(JSON.parse(frame.toString("utf8")));
      socket.end(encodeFrame(Buffer.from(JSON.stringify(reply))));
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
  const calls: { master: MasterOptions[]; sub: SubOptions[] } = { master: [], sub: [] };
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
          peers: [],
          intents: [],
        }),
        submitIntent: async () => ({ intentId: "N-1" }),
        attach: () => {
          throw new Error("fake master has no attach");
        },
        closed: masterClosed.promise,
        close: async () => masterClosed.resolve(),
      };
    },
    async connectSub(options): Promise<SubHandle> {
      calls.sub.push(options);
      return {
        sessionId: "S-1",
        peerId: "peer-1",
        fingerprint: "abcd-ef01-2345-6789",
        closed: subClosed.promise,
        close: async () => subClosed.resolve({ reason: "left" }),
      };
    },
  };
  return { api, calls };
}

async function harness(masterAddress?: { host: string; port: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-shell-"));
  roots.push(dir);
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
    expect(h.frame()).toContain("device laptop");
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
    expect(h.frame()).toContain("/join <code>");
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
    expect(h.scrollback()).toContain("no session — /start or /join first");
    await h.shell.quit();
  });

  it("/start runs a master in-process and prints the join code into the scrollback", async () => {
    const h = await harness();
    await h.shell.submit("/start --yes --repo app");
    expect(h.fake.calls.master).toHaveLength(1);
    expect(h.scrollback()).toContain("join code: 1234-5678-9012");
    expect(h.scrollback()).toContain("/join 1234-5678-9012 --host 192.168.1.20:7419");
    expect(h.frame()).toContain("session live");
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

  it("sends free text as an intent to this device's master", async () => {
    const control = await controlServer({
      type: "control-result",
      ok: true,
      result: { intentId: "N-7" },
    });
    const h = await harness({ host: "127.0.0.1", port: control.port });
    await h.shell.submit("/start --yes --repo app");
    await h.shell.submit("add a health check");
    expect(control.requests).toEqual([
      expect.objectContaining({ op: "intent", text: "add a health check" }),
    ]);
    expect(h.scrollback()).toContain("intent N-7: add a health check");
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
