import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os, { type NetworkInterfaceInfo, tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { skepHome, skepPaths } from "../../config/paths.js";
import type { Notification } from "../../notify/ntfy.js";
import { connectSub, ListenAddressError, startMaster } from "../../session/index.js";
import { type ItemStatus, SubResultSchema } from "../../session/messages.js";
import { runCli } from "../program.js";
import {
  type AgentRuntime,
  AgentRuntimeUnavailableError,
  type AgentSessionBackend,
  type AgentView,
  DEFAULT_PORT,
  DRY_RUN_SUMMARY,
  encodeFrame,
  expandStartWithMaster,
  FrameDecoder,
  fetchSessionStatus,
  formatJoinCli,
  herdrAgentName,
  type ItemWorker,
  itemTask,
  type JoinFlow,
  type JoinView,
  type JoinViewModel,
  joinSessionFlow,
  LAST_AUTO_PORT,
  loadAgentSetting,
  loadSubmitPolicy,
  type MasterHandle,
  type MasterOptions,
  NATIVE_ARGV,
  type PeerProgress,
  type PtyRunOptions,
  type PtyRunResult,
  parseAgentFlag,
  parseHostPort,
  pickListenHost,
  readControlEndpoint,
  renderSessionStatus,
  resolveAgentCli,
  type SessionApi,
  type SessionCliContext,
  type SessionStatus,
  SessionStatusSchema,
  type SubHandle,
  type SubOptions,
  saveAgentSetting,
  selectAgentView,
  serialQueue,
  setJoinViewFactory,
  summaryTail,
  undoItem,
  workItem,
} from "./session.js";
import { readDeltaRecord } from "./session-delta.js";

const roots: string[] = [];
const servers: net.Server[] = [];
const TOKEN = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  for (const dir of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-session-"));
  roots.push(dir);
  return dir;
}

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

const IFACES = {
  lo: [iface("127.0.0.1", true)],
  docker0: [iface("172.17.0.1")],
  tun0: [iface("10.8.0.2")],
  eth0: [iface("192.168.1.20")],
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fake session module: records options, never opens a socket. */
function fakeApi(listen = "192.168.1.20:7419") {
  const closed = deferred();
  const calls: { master: MasterOptions[]; sub: SubOptions[] } = { master: [], sub: [] };
  const api: SessionApi = {
    async startMaster(options): Promise<MasterHandle> {
      calls.master.push(options);
      const parsed = parseHostPort(listen);
      options.onJoinCode({ code: "1234-5678-9012", expiresAtMs: 1_800_000_000_000 });
      return {
        address: parsed,
        sessionId: "S-1",
        status: () => {
          throw new Error("fake master has no status");
        },
        submitIntent: async () => {
          throw new Error("fake master has no intent");
        },
        attach: () => {
          throw new Error("fake master has no attach");
        },
        closed: closed.promise,
        close: async () => closed.resolve(),
      };
    },
    async connectSub(options): Promise<SubHandle> {
      calls.sub.push(options);
      return {
        sessionId: "S-1",
        peerId: "P-1",
        fingerprint: "abcd-ef01-2345-6789",
        closed: Promise.resolve({ reason: "test" }),
        close: async () => {},
      };
    },
  };
  return { api, calls, closed };
}

function capture(dir: string, extra: Partial<SessionCliContext> = {}) {
  const out = { stdout: "", stderr: "" };
  const ctx: SessionCliContext = {
    stdout: {
      write: (s) => {
        out.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        out.stderr += s;
      },
    },
    // Only stubs and git: a real agent CLI on this machine must never be found by a test.
    env: { SKEP_HOME: dir, PATH: defaultStubs },
    output: () => {
      throw new Error("output() used before runCli");
    },
    networkInterfaces: () => IFACES,
    ...extra,
  };
  return {
    get stdout() {
      return out.stdout;
    },
    get stderr() {
      return out.stderr;
    },
    ctx,
  };
}

/** A master that answers one control request per connection with `reply` (or its result). */
async function mockMaster(
  reply: unknown | ((request: { v?: number }) => unknown),
): Promise<{ listen: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      const [frame] = decoder.push(chunk);
      if (frame === undefined) return;
      const request = JSON.parse(frame.toString("utf8")) as { v?: number };
      requests.push(request);
      const answer = typeof reply === "function" ? reply(request) : reply;
      socket.end(encodeFrame(Buffer.from(JSON.stringify(answer))));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return { listen: `127.0.0.1:${address.port}`, requests };
}

async function writeSessionFile(dir: string, listen: string): Promise<void> {
  await writeFile(path.join(dir, "session.json"), JSON.stringify({ listen, token: TOKEN }), {
    mode: 0o600,
  });
}

const STATUS: SessionStatus = {
  sessionId: "S-1",
  listen: "127.0.0.1:7419",
  repo: "app",
  joinCode: "123456789012",
  joinCodeExpiresAtMs: 1_800_000_000_000,
  peers: [
    {
      peerId: "P-1",
      device: "laptop",
      address: "192.168.1.30",
      family: "IPv4",
      repo: "app",
      head: "a".repeat(40),
      role: "coding",
    },
  ],
  intents: [],
};

describe("help and --startwithmaster", () => {
  it("lists the session subcommands", async () => {
    const c = capture(await home());
    expect(await runCli(["session", "--help"], c.ctx)).toBe(0);
    for (const sub of ["start", "join", "intent", "status"]) expect(c.stdout).toContain(sub);
  });

  it("hides --startwithmaster from root help", async () => {
    const c = capture(await home());
    expect(await runCli(["--help"], c.ctx)).toBe(0);
    expect(c.stdout).toContain("session");
    expect(c.stdout).not.toContain("startwithmaster");
  });

  it("rewrites the flag in place, and only without an explicit session", () => {
    expect(expandStartWithMaster(["--machine", "--startwithmaster", "--yes"])).toEqual([
      "--machine",
      "session",
      "start",
      "--yes",
    ]);
    expect(expandStartWithMaster(["status"])).toEqual(["status"]);
    const explicit = ["session", "status", "--startwithmaster"];
    expect(expandStartWithMaster(explicit)).toEqual(explicit);
  });

  it("--startwithmaster --yes starts a master and accepts joins", async () => {
    const fake = fakeApi();
    const c = capture(await home(), { sessionApi: fake.api });
    const run = runCli(["--startwithmaster", "--yes", "--repo", "app"], c.ctx);
    await vi.waitFor(() => expect(fake.calls.master).toHaveLength(1));
    const options = fake.calls.master[0];
    expect(options?.listen).toEqual({ host: "192.168.1.20", port: 7419 });
    expect(options?.controlToken).toMatch(/^[0-9a-f]{32}$/);
    expect(
      await options?.acceptJoin({
        device: "pc",
        address: "1.2.3.4",
        family: "IPv4",
        fingerprint: "x",
      }),
    ).toBe(true);
    fake.closed.resolve();
    expect(await run).toBe(0);
  });
});

describe("listen host", () => {
  it("skips lo, docker0 and tun0 and picks eth0", () => {
    expect(pickListenHost(IFACES)).toBe("192.168.1.20");
  });

  it("fails with no_interface when nothing qualifies", async () => {
    expect(() => pickListenHost({ lo: IFACES.lo, tun0: IFACES.tun0 })).toThrow(/LAN IPv4/);
    const fake = fakeApi();
    const c = capture(await home(), {
      sessionApi: fake.api,
      networkInterfaces: () => ({ lo: IFACES.lo }),
    });
    expect(await runCli(["--machine", "session", "start", "--repo", "app"], c.ctx)).toBe(1);
    expect(JSON.parse(c.stdout).error.code).toBe("no_interface");
    expect(fake.calls.master).toHaveLength(0);
  });

  it("rejects a wildcard --listen as a usage error", async () => {
    const fake = fakeApi();
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["session", "start", "--listen", "0.0.0.0:7419", "--repo", "app"];
    expect(await runCli(argv, c.ctx)).toBe(2);
    const v6 = ["session", "start", "--listen", "[::]:7419", "--repo", "app"];
    expect(await runCli(v6, c.ctx)).toBe(2);
    expect(fake.calls.master).toHaveLength(0);
  });
});

describe("session start", () => {
  it.each([undefined, "203.0.113.7:8500"])(
    "retries busy default ports and prints the bound or explicit advertise address (%j)",
    async (advertise) => {
      const fake = fakeApi(`192.168.1.20:${DEFAULT_PORT + 2}`);
      const bind = fake.api.startMaster;
      const attempts: MasterOptions[] = [];
      fake.api.startMaster = async (options) => {
        attempts.push(options);
        if (attempts.length <= 2) {
          throw new ListenAddressError("Unable to bind session listener", {
            cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
          });
        }
        return bind(options);
      };
      const dir = await home();
      const c = capture(dir, { sessionApi: fake.api });
      const run = runCli(
        [
          "session",
          "start",
          "--yes",
          "--repo",
          "app",
          ...(advertise ? ["--advertise", advertise] : []),
        ],
        c.ctx,
      );
      try {
        await vi.waitFor(() => expect(c.stdout).toContain("join code:"));
        expect(attempts.map((options) => options.listen)).toEqual([
          { host: "192.168.1.20", port: DEFAULT_PORT },
          { host: "192.168.1.20", port: DEFAULT_PORT + 1 },
          { host: "192.168.1.20", port: DEFAULT_PORT + 2 },
        ]);
        expect(new Set(attempts.map((options) => options.controlToken)).size).toBe(1);
        const dial = advertise ?? `192.168.1.20:${DEFAULT_PORT + 2}`;
        expect(c.stdout).toContain(`/join 1234-5678-9012 ${dial}`);
        expect(JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")).listen).toBe(
          `192.168.1.20:${DEFAULT_PORT + 2}`,
        );
        attempts.at(-1)?.onJoinCode({ code: "999988887777", expiresAtMs: 1_800_000_600_000 });
        expect(c.stdout).toContain(`/join 9999-8888-7777 ${dial}`);
      } finally {
        fake.closed.resolve();
        await run;
      }
      expect(await run).toBe(0);
    },
  );

  it("bounds automatic port retries and never publishes a pointer on exhaustion", async () => {
    const dir = await home();
    const fake = fakeApi();
    const bind = vi.fn(async () => {
      throw new ListenAddressError("Unable to bind session listener", {
        cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
      });
    });
    fake.api.startMaster = bind;
    const c = capture(dir, { sessionApi: fake.api });
    expect(await runCli(["--machine", "session", "start", "--repo", "app"], c.ctx)).toBe(1);
    expect(bind).toHaveBeenCalledTimes(LAST_AUTO_PORT - DEFAULT_PORT + 1);
    expect(bind).toHaveBeenLastCalledWith(
      expect.objectContaining({ listen: { host: "192.168.1.20", port: LAST_AUTO_PORT } }),
    );
    const error = JSON.parse(c.stdout).error;
    expect(error.code).toBe("session_port_in_use");
    expect(error.message).toContain(`${DEFAULT_PORT}–${LAST_AUTO_PORT}`);
    expect(error.message).toContain("--listen <host:unused-port>");
    await expect(stat(path.join(dir, "session.json"))).rejects.toThrow(/ENOENT/);
  });

  it("never retries an explicit busy listen address", async () => {
    const dir = await home();
    const fake = fakeApi();
    const bind = vi.fn(async () => {
      throw new ListenAddressError("Unable to bind session listener", {
        cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
      });
    });
    fake.api.startMaster = bind;
    const c = capture(dir, { sessionApi: fake.api });
    expect(
      await runCli(
        ["--machine", "session", "start", "--repo", "app", "--listen", "127.0.0.1:7420"],
        c.ctx,
      ),
    ).toBe(1);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(JSON.parse(c.stdout).error).toMatchObject({ code: "session_port_in_use" });
    expect(JSON.parse(c.stdout).error.message).toContain("127.0.0.1:7420 is already in use");
    await expect(stat(path.join(dir, "session.json"))).rejects.toThrow(/ENOENT/);
  });

  it("retries an actual bind collision using injected ephemeral loopback targets", async () => {
    const busy = await mockMaster({ type: "control-result", ok: true, result: STATUS });
    const attempts: MasterOptions[] = [];
    const masters: MasterHandle[] = [];
    const api: SessionApi = {
      ...fakeApi().api,
      async startMaster(options) {
        attempts.push(options);
        const master = await startMaster({
          ...options,
          listen:
            attempts.length === 1
              ? (parseHostPort(busy.listen) ?? undefined)
              : { host: "127.0.0.1", port: 0 },
        });
        masters.push(master);
        return master;
      },
    };
    const dir = await home();
    const c = capture(dir, { sessionApi: api });
    const run = runCli(["session", "start", "--repo", "app", "--yes"], c.ctx);
    try {
      await vi.waitFor(() => expect(c.stdout).toContain("join code:"));
      expect(attempts.map((options) => options.listen?.port)).toEqual([
        DEFAULT_PORT,
        DEFAULT_PORT + 1,
      ]);
      const pointer = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8"));
      expect(pointer.listen).not.toBe(busy.listen);
      expect(c.stdout).toMatch(new RegExp(`/join \\d{4}-\\d{4}-\\d{4} ${pointer.listen}\n`));
    } finally {
      await Promise.all(masters.map((master) => master.close()));
      await run;
    }
    expect(await run).toBe(0);
  });

  it("writes session.json while running and removes it after closed", async () => {
    const dir = await home();
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(dir, { sessionApi: fake.api });
    const file = path.join(dir, "session.json");
    const run = runCli(["session", "start", "--yes", "--repo", "app"], c.ctx);
    await vi.waitFor(async () => {
      await stat(file);
    });
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.listen).toBe("10.1.2.3:7500");
    expect(written.token).toMatch(/^[0-9a-f]{32}$/);
    expect(written.token).toBe(fake.calls.master[0]?.controlToken);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(c.stdout).toContain("10.1.2.3:7500");
    expect(c.stdout).toContain("1234-5678-9012");

    fake.calls.master[0]?.onJoinCode({
      code: "9999-8888-7777",
      expiresAtMs: 1_800_000_600_000,
    });
    expect(c.stdout).toContain("9999-8888-7777");

    fake.closed.resolve();
    expect(await run).toBe(0);
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it("prints the pasteable join line on the advertise address, and again on rotation", async () => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const run = runCli(
      ["session", "start", "--yes", "--repo", "app", "--advertise", "203.0.113.7:7419"],
      c.ctx,
    );
    await vi.waitFor(() => expect(c.stdout).toContain("join code:"));
    expect(c.stdout).toContain("session master listening on 10.1.2.3:7500 (repo app)");
    expect(c.stdout).toContain("peers dial 203.0.113.7:7419");
    expect(c.stdout).toContain("paste into skep: /join 1234-5678-9012 203.0.113.7:7419");
    expect(c.stdout).toContain(
      "or from a shell: skep session join --code 1234-5678-9012 --host 203.0.113.7:7419",
    );
    fake.calls.master[0]?.onJoinCode({ code: "999988887777", expiresAtMs: 1_800_000_600_000 });
    expect(c.stdout).toContain("/join 9999-8888-7777 203.0.113.7:7419");
    fake.closed.resolve();
    expect(await run).toBe(0);
  });

  it("--advertise is checked like --listen and reported in --machine output", async () => {
    const fake = fakeApi("10.1.2.3:7500");
    const bad = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app", "--advertise"];
    expect(await runCli([...argv, "0.0.0.0:7419"], bad.ctx)).toBe(2);
    expect(JSON.parse(bad.stdout).error.message).toMatch(/--advertise must name one interface/);
    expect(fake.calls.master).toHaveLength(0);

    const c = capture(await home(), { sessionApi: fake.api });
    const run = runCli(["--machine", "session", "start", "--yes", "--repo", "app"], c.ctx);
    await vi.waitFor(() => expect(c.stdout).toContain('"started"'));
    const started = JSON.parse(c.stdout.split("\n")[0] ?? "").result;
    expect(started).toMatchObject({ listen: "10.1.2.3:7500", advertise: "10.1.2.3:7500" });
    fake.closed.resolve();
    expect(await run).toBe(0);
  });

  it.each([
    "*:7419",
    " :7419",
    "a b:7419",
    "0.0.0.0:7419",
    "[::]:7419",
    "-x:7419",
    "host:0",
    "host",
    // Fix round 2: structure, not characters.
    "[1:::2]:7419",
    "[::%eth0]:7419",
    "[0:0:0:0:0:0:0:0%eth0]:7419",
    "[::ffff:0.0.0.0]:7419",
    "[fe80::1%]:7419",
    "a..b:7419",
    ".a:7419",
    "a.:7419",
    "a-.b:7419",
    "999.1.1.1:7419",
    "0:7419",
  ])("--advertise %j never reaches startMaster", async (advertise) => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app"];
    expect(await runCli([...argv, `--advertise=${advertise}`], c.ctx)).toBe(2);
    expect(JSON.parse(c.stdout).error.message).toMatch(/^--advertise must/);
    expect(fake.calls.master).toHaveLength(0);
  });

  it.each([
    ["[1:::2]:7419", /must name a hostname or IP address/],
    ["[::%eth0]:7419", /not a wildcard/],
    ["a..b:7419", /must name a hostname or IP address/],
  ])("--listen %j is refused like --advertise", async (listen, problem) => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app"];
    expect(await runCli([...argv, `--listen=${listen}`], c.ctx)).toBe(2);
    expect(JSON.parse(c.stdout).error.message).toMatch(problem);
    expect(fake.calls.master).toHaveLength(0);
  });

  it.each([
    ["mac.local:7419", "mac.local:7419"],
    ["203.0.113.7:7419", "203.0.113.7:7419"],
    ["[2001:db8::7]:7419", "[2001:db8::7]:7419"],
    ["[fe80::1%eth0]:7419", "[fe80::1%eth0]:7419"],
  ])("--advertise %j is accepted", async (advertise, shown) => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app"];
    const run = runCli([...argv, `--advertise=${advertise}`], c.ctx);
    await vi.waitFor(() => expect(c.stdout).toContain('"started"'));
    expect(JSON.parse(c.stdout.split("\n")[0] ?? "").result.advertise).toBe(shown);
    fake.closed.resolve();
    expect(await run).toBe(0);
  });

  it("--listen gets the same host checks", async () => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app", "--listen=*:7419"];
    expect(await runCli(argv, c.ctx)).toBe(2);
    expect(JSON.parse(c.stdout).error.message).toMatch(/--listen must name one interface/);
    expect(fake.calls.master).toHaveLength(0);
  });

  it("shell-quotes the CLI twin so a shell reads back the same arguments", async () => {
    const twin = formatJoinCli({ host: "[fe80::1]:7419", code: "863217270308" });
    expect(twin.startsWith("skep session join ")).toBe(true);
    // The twin is meant for a shell, so a real POSIX shell is the oracle here.
    const args = twin.slice("skep session join ".length);
    const { stdout } = await execFileP("sh", ["-c", `set -- ${args}; printf '%s\\0' "$@"`]);
    expect(stdout.split("\0").slice(0, -1)).toEqual([
      "--code",
      "8632-1727-0308",
      "--host",
      "[fe80::1]:7419",
    ]);
  });

  it("asks on stdin and accepts y", async () => {
    const fake = fakeApi();
    const stdin = new PassThrough();
    const c = capture(await home(), { sessionApi: fake.api, stdin });
    const run = runCli(["session", "start", "--repo", "app"], c.ctx);
    await vi.waitFor(() => expect(fake.calls.master).toHaveLength(1));
    const answer = fake.calls.master[0]?.acceptJoin({
      device: "laptop",
      address: "192.168.1.30",
      family: "IPv4",
      fingerprint: "abcd-ef01-2345-6789",
    });
    stdin.write("y\n");
    expect(await answer).toBe(true);
    expect(c.stderr).toContain("Accept laptop from 192.168.1.30 fingerprint abcd-ef01-2345-6789?");
    const declined = fake.calls.master[0]?.acceptJoin({
      device: "x",
      address: "1.1.1.1",
      family: "IPv4",
      fingerprint: "f",
    });
    stdin.write("n\n");
    expect(await declined).toBe(false);
    fake.closed.resolve();
    expect(await run).toBe(0);
  });

  it.each([{ listenArgs: [] }, { listenArgs: ["--listen", "127.0.0.1:7420"] }])(
    "refuses a live master when explicit overrides share the home (%j)",
    async ({ listenArgs }) => {
      const dir = await home();
      const mock = await mockMaster({
        type: "control-result",
        ok: true,
        result: { ...STATUS, repo: "proj-a" },
      });
      await writeSessionFile(dir, mock.listen);
      const before = await readFile(path.join(dir, "session.json"), "utf8");
      const fake = fakeApi();
      const c = capture(dir, { sessionApi: fake.api, cwd: path.join(dir, "proj-b") });
      expect(
        await runCli(["--machine", "session", "start", "--repo", "proj-b", ...listenArgs], c.ctx),
      ).toBe(1);
      const error = JSON.parse(c.stdout).error;
      expect(error.code).toBe("session_running");
      expect(error.message).toContain(mock.listen);
      expect(error.message).toContain("one session per home");
      expect(error.message).toContain("skep --home <separate-dir>");
      expect(error.message).toContain("omit the override");
      expect(error.message).toContain("ports automatically");
      expect(fake.calls.master).toHaveLength(0);
      expect(mock.requests).toEqual([{ type: "control", v: 1, token: TOKEN, op: "status" }]);
      expect(await readFile(path.join(dir, "session.json"), "utf8")).toBe(before);
    },
  );

  it("explains a port collision even when the second master has a separate home", async () => {
    const dir = await home();
    const mock = await mockMaster({ type: "control-result", ok: true, result: STATUS });
    await writeSessionFile(dir, mock.listen);
    const before = await readFile(path.join(dir, "session.json"), "utf8");
    const separate = await home();
    const c = capture(dir);
    expect(
      await runCli(
        [
          "--machine",
          "--home",
          separate,
          "session",
          "start",
          "--repo",
          "proj-b",
          "--listen",
          mock.listen,
        ],
        c.ctx,
      ),
    ).toBe(1);
    const error = JSON.parse(c.stdout).error;
    expect(error.code).toBe("session_port_in_use");
    expect(error.message).toContain(mock.listen);
    expect(error.message).toContain("--listen <host:unused-port>");
    expect(error.message).toContain("available ports automatically");
    expect(await readFile(path.join(dir, "session.json"), "utf8")).toBe(before);
    await expect(stat(path.join(separate, "session.json"))).rejects.toThrow(/ENOENT/);
    expect(mock.requests).toEqual([]);
  });

  it("preserves bind errors that are not port collisions", async () => {
    const fake = fakeApi();
    const failure = new ListenAddressError("listener permission denied", {
      cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
    });
    fake.api.startMaster = async () => {
      throw failure;
    };
    const c = capture(await home(), { sessionApi: fake.api });
    expect(await runCli(["--machine", "session", "start", "--repo", "app"], c.ctx)).toBe(1);
    expect(JSON.parse(c.stdout).error).toEqual({
      code: "error",
      message: "listener permission denied",
    });
  });

  it("keeps two concurrent masters isolated with SKEP_HOME and --home", async () => {
    const firstHome = await home();
    const secondHome = await home();
    const masters: MasterHandle[] = [];
    const options: MasterOptions[] = [];
    const runs: Promise<number>[] = [];
    const api: SessionApi = {
      ...fakeApi().api,
      async startMaster(opts) {
        options.push(opts);
        // Ephemeral loopback ports avoid reserving fixed ports on the test machine.
        const master = await startMaster({ ...opts, listen: { host: "127.0.0.1", port: 0 } });
        masters.push(master);
        return master;
      },
    };
    const first = capture(firstHome, { sessionApi: api, cwd: path.join(firstHome, "proj-a") });
    const second = capture(firstHome, { sessionApi: api, cwd: path.join(secondHome, "proj-b") });
    try {
      runs.push(runCli(["--machine", "session", "start", "--repo", "proj-a", "--yes"], first.ctx));
      await vi.waitFor(() => expect(first.stdout).toContain('"started"'));
      runs.push(
        runCli(
          [
            "--machine",
            "--home",
            secondHome,
            "session",
            "start",
            "--repo",
            "proj-b",
            "--yes",
            "--listen",
            "127.0.0.1:7420",
          ],
          second.ctx,
        ),
      );
      await vi.waitFor(() => expect(second.stdout).toContain('"started"'));
      expect(options[0]?.listen?.port).toBe(7419);
      expect(options[1]?.listen).toEqual({ host: "127.0.0.1", port: 7420 });
      expect(first.ctx.paths?.home).toBe(firstHome);
      expect(second.ctx.paths?.home).toBe(secondHome);
      const a = await fetchSessionStatus(first.ctx);
      const b = await fetchSessionStatus(second.ctx);
      expect(a.repo).toBe("proj-a");
      expect(b.repo).toBe("proj-b");
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.listen).not.toBe(b.listen);
      await masters[0]?.close();
      expect(await runs[0]).toBe(0);
      await expect(stat(path.join(firstHome, "session.json"))).rejects.toThrow(/ENOENT/);
      expect((await fetchSessionStatus(second.ctx)).sessionId).toBe(b.sessionId);
    } finally {
      await Promise.all(masters.map((master) => master.close()));
      await Promise.all(runs);
    }
    expect(await Promise.all(runs)).toEqual([0, 0]);
    await expect(stat(path.join(secondHome, "session.json"))).rejects.toThrow(/ENOENT/);
  });

  it("isolates concurrent default project homes and shares same-root discovery", async () => {
    const userHome = await home();
    const firstProject = path.join(userHome, "first", "app");
    const secondProject = path.join(userHome, "second", "app");
    await mkdir(firstProject, { recursive: true });
    await mkdir(secondProject, { recursive: true });
    const env = { HOME: userHome, PATH: process.env.PATH };
    await gitIn(firstProject, ["init", "--quiet"], env);
    const nested = path.join(firstProject, "src");
    await mkdir(nested);
    const firstFake = fakeApi();
    const secondFake = fakeApi(`192.168.1.20:${DEFAULT_PORT + 1}`);
    const bind = secondFake.api.startMaster;
    secondFake.api.startMaster = async (options) => {
      if (options.listen?.port === DEFAULT_PORT) {
        throw new ListenAddressError("Unable to bind session listener", {
          cause: Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
        });
      }
      return bind(options);
    };
    const first = capture(userHome, { env, cwd: firstProject, sessionApi: firstFake.api });
    const second = capture(userHome, { env, cwd: secondProject, sessionApi: secondFake.api });
    const firstRun = runCli(["session", "start", "--repo", "app", "--yes"], first.ctx);
    const secondRun = runCli(["session", "start", "--repo", "app", "--yes"], second.ctx);
    try {
      await vi.waitFor(() => expect(first.stdout).toContain("join code:"));
      await vi.waitFor(() => expect(second.stdout).toContain("join code:"));
      const firstHome = await skepHome(env, firstProject);
      const secondHome = await skepHome(env, secondProject);
      expect(firstHome).not.toBe(secondHome);
      expect(first.ctx.paths?.home).toBe(firstHome);
      expect(second.ctx.paths?.home).toBe(secondHome);
      const peer = capture(userHome, { env, cwd: nested });
      peer.ctx.paths = skepPaths(await skepHome(env, nested));
      expect(await readControlEndpoint(peer.ctx)).toEqual(await readControlEndpoint(first.ctx));
      expect(await readControlEndpoint(second.ctx)).not.toEqual(
        await readControlEndpoint(first.ctx),
      );
      expect(second.stdout).toMatch(
        new RegExp(`/join \\d{4}-\\d{4}-\\d{4} 192\\.168\\.1\\.20:${DEFAULT_PORT + 1}\n`),
      );
      firstFake.closed.resolve();
      expect(await firstRun).toBe(0);
      await expect(stat(path.join(firstHome, "session.json"))).rejects.toThrow(/ENOENT/);
      expect(await readControlEndpoint(second.ctx)).not.toBeNull();
      await expect(stat(path.join(userHome, ".skep", "session.json"))).rejects.toThrow(/ENOENT/);
    } finally {
      firstFake.closed.resolve();
      secondFake.closed.resolve();
      await Promise.all([firstRun, secondRun]);
    }
    expect(await secondRun).toBe(0);
    expect(await readControlEndpoint(second.ctx)).toBeNull();
  });

  it("scopes real master status, live guards, and cleanup to default project homes", async () => {
    const userHome = await home();
    const projects = [path.join(userHome, "proj-a"), path.join(userHome, "proj-b")];
    await Promise.all(projects.map((project) => mkdir(project)));
    const env = { HOME: userHome, PATH: process.env.PATH };
    const masters: MasterHandle[] = [];
    const api: SessionApi = {
      ...fakeApi().api,
      async startMaster(options) {
        const master = await startMaster({ ...options, listen: { host: "127.0.0.1", port: 0 } });
        masters.push(master);
        return master;
      },
    };
    const first = capture(userHome, { env, cwd: projects[0], sessionApi: api });
    const second = capture(userHome, { env, cwd: projects[1], sessionApi: api });
    const runs: Promise<number>[] = [];
    try {
      runs.push(runCli(["--machine", "session", "start", "--repo", "proj-a", "--yes"], first.ctx));
      await vi.waitFor(() => expect(first.stdout).toContain('"started"'));
      const peer = capture(userHome, { env, cwd: projects[0] });
      expect(await runCli(["--machine", "session", "status"], peer.ctx)).toBe(0);
      expect(JSON.parse(peer.stdout).result.repo).toBe("proj-a");
      const duplicateFake = fakeApi();
      const duplicate = capture(userHome, { env, cwd: projects[0], sessionApi: duplicateFake.api });
      expect(
        await runCli(["--machine", "session", "start", "--repo", "proj-a"], duplicate.ctx),
      ).toBe(1);
      expect(JSON.parse(duplicate.stdout).error.code).toBe("session_running");
      expect(duplicateFake.calls.master).toHaveLength(0);
      // Another project cannot discover the first pointer, even before it has its own master.
      expect(await runCli(["--machine", "session", "status"], second.ctx)).toBe(1);
      expect(JSON.parse(second.stdout).error.code).toBe("no_session");
      runs.push(runCli(["--machine", "session", "start", "--repo", "proj-b", "--yes"], second.ctx));
      await vi.waitFor(() => expect(masters).toHaveLength(2));
      await vi.waitFor(async () => expect(await readControlEndpoint(second.ctx)).not.toBeNull());
      expect((await fetchSessionStatus(first.ctx)).repo).toBe("proj-a");
      const b = await fetchSessionStatus(second.ctx);
      expect(b.repo).toBe("proj-b");
      expect(first.ctx.paths?.home).not.toBe(second.ctx.paths?.home);
      await masters[0]?.close();
      expect(await runs[0]).toBe(0);
      expect(await readControlEndpoint(first.ctx)).toBeNull();
      expect((await fetchSessionStatus(second.ctx)).sessionId).toBe(b.sessionId);
    } finally {
      await Promise.all(masters.map((master) => master.close()));
      await Promise.all(runs);
    }
    expect(await Promise.all(runs)).toEqual([0, 0]);
    expect(await readControlEndpoint(second.ctx)).toBeNull();
  });
});

describe("session join", () => {
  it("keeps self first, upserts peers by join number, removes left peers, and reports agent state", async () => {
    const box = await sandbox();
    const log = recordingView();
    const connected = deferred();
    const closed = deferred();
    const fake = fakeApi();
    const reportAgent = vi.fn();
    fake.api.connectSub = async (options) => {
      fake.calls.sub.push(options);
      await connected.promise;
      return {
        peerId: "peer-5",
        sessionId: "S-1",
        fingerprint: "fingerprint",
        reportAgent,
        closed: closed.promise.then(() => ({ reason: "test" })),
        close: async () => closed.resolve(),
      };
    };
    setJoinViewFactory(() => log.view);
    const c = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
    const run = runCli(
      [
        "--machine",
        "session",
        "join",
        "--ui",
        "--code",
        "123456789012",
        "--host",
        "h:1",
        "--repo",
        "app",
        "--device",
        "mac",
        "--role",
        "backend",
        "--submit",
        "none",
      ],
      c.ctx,
    );
    try {
      await vi.waitFor(() => expect(fake.calls.sub).toHaveLength(1));
      const options = fake.calls.sub[0];
      if (options?.onProgress === undefined) throw new Error("missing progress callback");
      const progress: PeerProgress = {
        peerId: "peer-5",
        device: "mac",
        role: "backend",
        phase: "idle",
        done: 0,
        total: 0,
        failed: 0,
        percent: 0,
        summary: "",
      };
      options.onProgress({ ...progress, self: true });
      options.onProgress({
        ...progress,
        peerId: "peer-10",
        device: "vps",
        role: null,
        self: false,
      });
      options.onProgress({ ...progress, peerId: "peer-2", device: "desk", self: false });
      options.onProgress({
        ...progress,
        peerId: "peer-2",
        device: "desk",
        phase: "working",
        done: 3,
        total: 8,
        percent: 37,
        summary: "health check",
        self: false,
      });
      expect(log.models.at(-1)?.peers.map((peer) => peer.peerId)).toEqual([
        "peer-5",
        "peer-2",
        "peer-10",
      ]);
      expect(log.models.at(-1)?.peers[1]).toMatchObject({
        state: "working",
        progress: { percent: 37, summary: "health check" },
      });
      expect(log.models.at(-1)?.peers[2]?.role).toBe("-");
      connected.resolve();
      await vi.waitFor(() => expect(c.stdout).toContain('"event":"joined"'));
      expect(log.models.at(-1)?.peers[0]).toMatchObject({
        peerId: "peer-5",
        state: "idle",
        progress: { phase: "idle" },
      });
      options.onProgress({
        ...progress,
        peerId: "peer-2",
        device: "desk",
        phase: "left",
        self: false,
      });
      expect(log.models.at(-1)?.peers.map((peer) => peer.peerId)).toEqual(["peer-5", "peer-10"]);
      await options.onItem(ITEM);
      expect(reportAgent).toHaveBeenCalledWith(ITEM.itemId, "done");
    } finally {
      connected.resolve();
      closed.resolve();
      await run;
      setJoinViewFactory(null);
    }
    expect(log.events.at(-1)).toBe("close");
  });

  it("emits machine peer-progress only on per-peer phase changes", async () => {
    const fake = fakeApi();
    fake.api.connectSub = async (options) => {
      const progress: PeerProgress = {
        peerId: "peer-2",
        device: "vps",
        role: null,
        phase: "working",
        done: 3,
        total: 8,
        failed: 0,
        percent: 37,
        summary: "health check",
      };
      options.onProgress?.({ ...progress, self: false });
      options.onProgress?.({
        ...progress,
        done: 4,
        percent: 50,
        summary: "more work",
        self: false,
      });
      options.onProgress?.({ ...progress, peerId: "peer-3", device: "desk", self: false });
      options.onProgress?.({ ...progress, phase: "done", done: 8, percent: 100, self: false });
      options.onProgress?.({ ...progress, phase: "done", done: 8, percent: 100, self: false });
      options.onProgress?.({
        ...progress,
        phase: "left",
        done: 0,
        total: 0,
        percent: 0,
        summary: "",
        self: false,
      });
      return {
        peerId: "peer-1",
        sessionId: "S-1",
        fingerprint: "fp",
        closed: Promise.resolve({ reason: "test" }),
        close: async () => {},
      };
    };
    const c = capture(await home(), { sessionApi: fake.api });
    expect(
      await runCli(
        [
          "--machine",
          "session",
          "join",
          "--code",
          "123456789012",
          "--host",
          "h:1",
          "--repo",
          "app",
          "--submit",
          "none",
        ],
        c.ctx,
      ),
    ).toBe(0);
    const events = c.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line).result as {
            event: string;
            peerId: string;
            phase: string;
            percent: number;
            self: boolean;
          },
      );
    expect(
      events
        .filter((event) => event.event === "peer-progress")
        .map((event) => [event.peerId, event.phase, event.percent]),
    ).toEqual([
      ["peer-2", "working", 37],
      ["peer-3", "working", 37],
      ["peer-2", "done", 100],
      ["peer-2", "left", 0],
    ]);
  });

  it("prints human progress without a UI", async () => {
    const fake = fakeApi();
    const connect = fake.api.connectSub;
    fake.api.connectSub = async (options) => {
      options.onProgress?.({
        peerId: "peer-2",
        device: "vps",
        role: null,
        phase: "working",
        done: 3,
        total: 8,
        failed: 0,
        percent: 37,
        summary: "",
        self: false,
      });
      return connect(options);
    };
    const c = capture(await home(), { sessionApi: fake.api });
    expect(
      await runCli(
        [
          "session",
          "join",
          "--code",
          "123456789012",
          "--host",
          "h:1",
          "--repo",
          "app",
          "--submit",
          "none",
        ],
        c.ctx,
      ),
    ).toBe(0);
    expect(c.stdout).toContain("peer vps working 3/8 (37%)\n");
  });

  it("rejects a short code with exit 2", async () => {
    const fake = fakeApi();
    const c = capture(await home(), { sessionApi: fake.api });
    expect(await runCli(["session", "join", "--code", "12", "--host", "h:1"], c.ctx)).toBe(2);
    expect(fake.calls.sub).toHaveLength(0);
  });

  it("needs a host when there is no local session.json", async () => {
    const fake = fakeApi();
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "join", "--code", "123456789012", "--repo", "app"];
    expect(await runCli(argv, c.ctx)).not.toBe(0);
    expect(JSON.parse(c.stdout).error.code).toBe("host_required");
  });

  it("passes the normalized code and target to connectSub", async () => {
    const fake = fakeApi();
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = [
      "session",
      "join",
      "--code",
      "1234-5678 9012",
      "--host",
      "10.0.0.5:7419",
      "--repo",
      "app",
      "--device",
      "laptop",
    ];
    expect(await runCli(argv, c.ctx)).toBe(0);
    const options = fake.calls.sub[0];
    expect(options?.code).toBe("123456789012");
    expect(options?.target).toEqual({ host: "10.0.0.5", port: 7419 });
    expect(options?.device).toBe("laptop");
    expect(c.stdout).toContain("abcd-ef01-2345-6789");
    const described = await options?.describe();
    expect(described?.role).toBe("coding");
    expect(described?.repo).toBe("app");
  });

  it("defaults the host to the local session.json", async () => {
    const dir = await home();
    await writeSessionFile(dir, "192.168.1.20:7419");
    const fake = fakeApi();
    const c = capture(dir, { sessionApi: fake.api });
    const argv = ["session", "join", "--code", "123456789012", "--repo", "app"];
    expect(await runCli(argv, c.ctx)).toBe(0);
    expect(fake.calls.sub[0]?.target).toEqual({ host: "192.168.1.20", port: 7419 });
  });
});

describe("control commands", () => {
  it("status shows each last result whole: no event cap, failed submits and waits named", () => {
    const words = Array.from({ length: 150 }, (_, n) => `w${String(n).padStart(3, "0")}`);
    const long = [
      "submit none local",
      "done · claude · 3s",
      ...Array.from({ length: 10 }, (_, n) => `line ${n}`),
      `summary: ${words.join(" ")}`,
    ].join("\n");
    expect(long.length).toBeGreaterThan(600);
    const item = (itemId: string, summary: string, state: "local" | "failed" | "pending") => ({
      itemId,
      repo: "app",
      assignee: "P-1",
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
        checks: [{ name: "agent", status: "skip" as const }],
        submit: {
          method: state === "local" ? ("none" as const) : ("push" as const),
          state,
          branch: "main",
        },
        summary,
      },
    });
    const status: SessionStatus = {
      ...STATUS,
      intents: [
        {
          intentId: "intent-1",
          text: "ship it",
          state: "planned",
          items: [
            item("I-1", long, "local"),
            item(
              "I-2",
              "submit push failed\nFAILED · claude · 1s\ncause: submit push failed: no",
              "failed",
            ),
            item(
              "I-3",
              "submit push pending\nblocked · claude · 1s\nagent x is waiting",
              "pending",
            ),
          ],
        },
      ],
    };
    const text = renderSessionStatus(SessionStatusSchema.parse(status));
    expect(text.match(/w\d{3}/g)).toEqual(words);
    expect(text).toContain("line 9");
    expect(text).toContain("1 done · 0 failed · 1 submit failed · 1 waiting for you");
    expect(text).toMatch(/I-2\s+submit-failed/);
    expect(text).toMatch(/I-3\s+pending/);
    expect(text).toContain("I-2 SUBMIT FAILED · laptop (app) · claude · 1s");
    expect(text).toContain("I-3 WAITING · laptop (app) · claude · 1s");
  });

  it("accepts status with and without progress and renders its column", () => {
    expect(SessionStatusSchema.parse(STATUS)).toEqual(STATUS);
    expect(renderSessionStatus(STATUS)).toContain("PROGRESS");
    const progress = {
      phase: "working",
      done: 3,
      total: 8,
      failed: 1,
      percent: 37,
      summary: "health check",
      itemId: "I-1",
    };
    const current = { ...STATUS, peers: STATUS.peers.map((peer) => ({ ...peer, progress })) };
    const parsed = SessionStatusSchema.parse(current);
    expect(parsed.peers[0]?.progress).toEqual(progress);
    expect(renderSessionStatus(parsed)).toContain("working 37%");
  });

  it("distinguishes development, published and v1 peers in the SKEP column", () => {
    const peer = STATUS.peers[0];
    if (peer === undefined) throw new Error("missing fixture peer");
    const status = SessionStatusSchema.parse({
      ...STATUS,
      peers: [
        { ...peer, peerId: "dev", protocol: 2, version: "0.2.0-dev", shareOutput: true },
        { ...peer, peerId: "published", protocol: 2, version: "0.1.13", shareOutput: false },
        { ...peer, peerId: "legacy", protocol: 1, version: null, shareOutput: false },
      ],
    });
    const text = renderSessionStatus(status);
    expect(text).toContain("SKEP");
    expect(text).toMatch(/dev\s+.*\s0\.2\.0-dev \+live/);
    expect(text).toMatch(/published\s+.*\s0\.1\.13\n/);
    expect(text).toMatch(/legacy\s+.*\s≤0\.1\.13\n/);
  });

  it.each([
    { done: 9 },
    { failed: 4 },
    { percent: 38 },
    { done: 1.5 },
    { summary: "x".repeat(121) },
    { itemId: "invalid" },
    { phase: "left" },
    { unknown: true },
  ])("rejects malformed status progress: %j", (invalid) => {
    const progress = {
      phase: "working",
      done: 3,
      total: 8,
      failed: 0,
      percent: 37,
      summary: "",
      ...invalid,
    };
    expect(
      SessionStatusSchema.safeParse({
        ...STATUS,
        peers: STATUS.peers.map((peer) => ({ ...peer, progress })),
      }).success,
    ).toBe(false);
  });

  it("intent sends the token and text and prints the intentId", async () => {
    const dir = await home();
    const mock = await mockMaster({
      type: "control-result",
      ok: true,
      result: { intentId: "N-7" },
    });
    await writeSessionFile(dir, mock.listen);
    const c = capture(dir);
    const argv = ["session", "intent", "add a health check", "--repo", "app", "api"];
    expect(await runCli(argv, c.ctx)).toBe(0);
    expect(mock.requests).toEqual([
      {
        type: "control",
        v: 1,
        token: TOKEN,
        op: "intent",
        text: "add a health check",
        repos: ["app", "api"],
      },
    ]);
    expect(c.stdout).toBe("N-7\n");
  });

  it("status --machine prints one JSON line", async () => {
    const dir = await home();
    const mock = await mockMaster({ type: "control-result", ok: true, result: STATUS });
    await writeSessionFile(dir, mock.listen);
    const c = capture(dir);
    expect(await runCli(["--machine", "session", "status"], c.ctx)).toBe(0);
    const lines = c.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ ok: true, result: STATUS });
    expect(mock.requests).toEqual([{ type: "control", v: 2, token: TOKEN, op: "status" }]);
  });

  it("status asks a ≤0.1.13 master again in v1 after it refuses v2 (ORCH-6)", async () => {
    const dir = await home();
    const mock = await mockMaster((request: { v?: number }) =>
      request.v === 2
        ? {
            type: "control-result",
            ok: false,
            error: { code: "bad_request", message: "Invalid first session request" },
          }
        : { type: "control-result", ok: true, result: STATUS },
    );
    await writeSessionFile(dir, mock.listen);
    const c = capture(dir);
    expect(await runCli(["--machine", "session", "status"], c.ctx)).toBe(0);
    expect(JSON.parse(c.stdout.trim())).toEqual({ ok: true, result: STATUS });
    expect(mock.requests).toEqual([
      { type: "control", v: 2, token: TOKEN, op: "status" },
      { type: "control", v: 1, token: TOKEN, op: "status" },
    ]);
  });

  it("status renders a human table", async () => {
    const dir = await home();
    const mock = await mockMaster({ type: "control-result", ok: true, result: STATUS });
    await writeSessionFile(dir, mock.listen);
    const c = capture(dir);
    expect(await runCli(["session", "status"], c.ctx)).toBe(0);
    expect(c.stdout).toContain("1234-5678-9012");
    expect(c.stdout).toContain("laptop");
  });

  it("maps ok:false to its code with exit 3", async () => {
    const dir = await home();
    const mock = await mockMaster({
      type: "control-result",
      ok: false,
      error: { code: "bad_token", message: "token mismatch" },
    });
    await writeSessionFile(dir, mock.listen);
    const c = capture(dir);
    expect(await runCli(["--machine", "session", "status"], c.ctx)).toBe(3);
    expect(JSON.parse(c.stdout).error.code).toBe("bad_token");
  });

  it("fails with no_session when session.json is missing", async () => {
    const c = capture(await home());
    expect(await runCli(["--machine", "session", "intent", "x"], c.ctx)).toBe(1);
    expect(JSON.parse(c.stdout).error.code).toBe("no_session");
  });
});

// ---------------------------------------------------------------------------------------------
// Sub-side item work against a real in-memory master and throwaway git repos. Never a real agent
// CLI and no network: PATH holds only stub agents and a `git` wrapper that logs every call (the
// spy for "no worktree, clone or branch"); `origin` is a local bare repo; gh/glab are absent.

const execFileP = promisify(execFile);
const HOST = "127.0.0.1";
let realGit = "";
let realCat = "";
let realSleep = "";
/** A PATH dir with a stub `claude` and plain `git`, for tests that only need some agent. */
let defaultStubs = "";

beforeAll(async () => {
  realGit = (await execFileP("sh", ["-c", "command -v git"])).stdout.trim();
  realCat = (await execFileP("sh", ["-c", "command -v cat"])).stdout.trim();
  realSleep = (await execFileP("sh", ["-c", "command -v sleep"])).stdout.trim();
  defaultStubs = await mkdtemp(path.join(tmpdir(), "skep-stubs-"));
  await symlink(realGit, path.join(defaultStubs, "git"));
  await writeFile(path.join(defaultStubs, "claude"), '#!/bin/sh\necho "stub claude"\n', {
    mode: 0o755,
  });
});

afterAll(async () => {
  await rm(defaultStubs, { recursive: true, force: true });
});

interface Sandbox {
  home: string;
  repo: string;
  bare: string;
  /** Stub agents go here; it is first on PATH. */
  bin: string;
  /** Every git invocation, one line of arguments each. */
  gitLog: string;
  env: NodeJS.ProcessEnv;
}

async function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return (
    await execFileP(realGit || "git", args, { cwd, env: env as Record<string, string> })
  ).stdout.trim();
}

async function gitCalls(box: Sandbox): Promise<string[]> {
  return (await readFile(box.gitLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

/**
 * Writes a stub agent CLI into the sandbox. `body` is shell run in the project folder; it records
 * argv and stdin under $HOME so they never show up as changed files.
 */
async function stubAgent(box: Sandbox, name: string, body = 'echo "stub done"'): Promise<void> {
  await writeFile(
    path.join(box.bin, name),
    `#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/${name}-args.txt"\n` +
      `${realCat} > "$HOME/${name}-stdin.txt"\n: > "$HOME/${name}-called"\n${body}\n`,
    { mode: 0o755 },
  );
}

/** A repo named `app` with one commit and a bare `origin`; HOME points into the temp dir. */
async function sandbox(): Promise<Sandbox> {
  const root = await home();
  const repo = path.join(root, "app");
  const bare = path.join(root, "origin.git");
  const fakeHome = path.join(root, "userhome");
  const bin = path.join(root, "bin");
  const tools = path.join(root, "tools");
  const gitLog = path.join(root, "git.log");
  await mkdir(repo);
  await mkdir(fakeHome);
  await mkdir(bin);
  await mkdir(tools);
  await writeFile(
    path.join(tools, "git"),
    `#!/bin/sh\nprintf "%s\\n" "$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}${path.delimiter}${tools}`,
    HOME: fakeHome,
    SKEP_HOME: path.join(root, "skep"),
  };
  const who = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  await gitIn(root, ["init", "--quiet", "--bare", bare], env);
  await gitIn(repo, ["init", "--quiet", "-b", "main"], env);
  await writeFile(path.join(repo, "README.md"), "app\n");
  await writeFile(path.join(repo, "notes.txt"), "one\ntwo\n");
  await gitIn(repo, ["add", "README.md", "notes.txt"], env);
  await gitIn(repo, [...who, "commit", "--quiet", "-m", "init"], env);
  await gitIn(repo, ["remote", "add", "origin", bare], env);
  await gitIn(repo, ["push", "--quiet", "origin", "main"], env);
  const box = { home: root, repo, bare, bin, gitLog, env };
  // The default agent edits one file and adds another, then says what it did.
  await stubAgent(
    box,
    "claude",
    'printf "one\\nTWO\\nthree\\n" > notes.txt\nprintf "ok\\n" > health.txt\n' +
      'echo "working"\necho\necho "Added a health check file."',
  );
  return box;
}

async function remoteHas(box: Sandbox, branch: string): Promise<string | null> {
  return gitIn(
    box.repo,
    ["--git-dir", box.bare, "rev-parse", "--verify", `refs/heads/${branch}`],
    box.env,
  ).catch(() => null);
}

async function startTestMaster(events?: { kind: string; message: string }[]) {
  return startMaster({
    listen: { host: HOST, port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
    ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
  });
}

/** Runs `skep session join` against a real master, sends one intent, returns the item status. */
async function joinAndWork(
  box: Sandbox,
  extraArgs: string[],
  extra: Partial<SessionCliContext> = {},
  machine = true,
): Promise<{
  item: ItemStatus;
  run: ReturnType<typeof capture>;
  exit: number;
  events: { kind: string; message: string }[];
}> {
  const events: { kind: string; message: string }[] = [];
  const master = await startTestMaster(events);
  try {
    const code = master.status().joinCode;
    if (code === null || master.address === null) throw new Error("master has no join code");
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
      ...extra,
    });
    const argv = [
      ...(machine ? ["--machine"] : []),
      "session",
      "join",
      "--code",
      code,
      "--host",
      `${HOST}:${master.address.port}`,
      "--repo",
      "app",
      "--device",
      "vps",
      ...extraArgs,
    ];
    const exit = runCli(argv, c.ctx);
    await vi.waitFor(() => expect(master.status().peers).toHaveLength(1), { timeout: 5_000 });
    await master.submitIntent("add a health check");
    await vi.waitFor(() => expect(master.status().intents[0]?.items[0]?.state).toBe("done"), {
      timeout: 10_000,
    });
    // One final roll-up, whatever the outcome: done, failed or waiting for the human.
    await vi.waitFor(() => expect(events.some((e) => e.kind.startsWith("intent-"))).toBe(true));
    const item = master.status().intents[0]?.items[0];
    if (item === undefined) throw new Error("no item");
    await master.close();
    return { item, run: c, exit: await exit, events };
  } finally {
    await master.close();
  }
}

describe("session join works items in the project folder", () => {
  it("runs the agent with cwd = project root and never adds a worktree, clone or branch", async () => {
    const box = await sandbox();
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item, exit, events } = await joinAndWork(box, ["--submit", "none"]);
    expect(exit).toBe(0);
    // The agent ran in the folder itself and its edits are there, uncommitted.
    expect(await readFile(path.join(box.repo, "health.txt"), "utf8")).toBe("ok\n");
    expect(await readFile(path.join(box.env.HOME ?? "", "claude-args.txt"), "utf8")).toBe("-p\n");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe(
      "M notes.txt\n?? health.txt",
    );
    const calls = await gitCalls(box);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/^(worktree|clone|branch|checkout|switch|stash|reset|clean)\b/);
    }
    expect(await gitIn(box.repo, ["branch", "--list", "skep/*"], box.env)).toBe("");
    await expect(
      stat(path.join(box.env.SKEP_HOME ?? "", "session", "worktrees")),
    ).rejects.toThrow();
    expect(item.result).toMatchObject({
      baseSha: base,
      headSha: base,
      checks: [{ name: "none", status: "skip" }],
      submit: { method: "none", state: "local", branch: "main" },
    });
    const lines = item.result?.summary.split("\n") ?? [];
    expect(lines[0]).toBe("submit none local");
    expect(lines[1]).toMatch(/^done · claude · \d+s$/);
    expect(lines[2]).toBe("changed 2 files (+3 −1): health.txt, notes.txt");
    expect(lines[3]).toBe("summary: Added a health check file.");
    const block = events.find((e) => e.kind === "item-result")?.message ?? "";
    expect(block).toMatch(/^I-1 done · vps \(app\) · claude · \d+s\n {2}changed 2 files/);
    expect(events.find((e) => e.kind === "intent-done")?.message).toBe(
      "intent-1 done: add a health check\n  1 done · 0 failed · 2 files changed",
    );
  });

  it("two sessions on the same device and project both run their I-1", async () => {
    const box = await sandbox();
    const first = await joinAndWork(box, ["--submit", "none"]);
    // The second agent appends, so it really changes something again.
    await stubAgent(box, "claude", 'printf "again\\n" >> health.txt');
    const second = await joinAndWork(box, ["--submit", "none"]);
    for (const { item } of [first, second]) {
      expect(item.itemId).toBe("I-1");
      expect(item.result?.checks).not.toContainEqual(expect.objectContaining({ status: "fail" }));
    }
    expect(second.item.result?.summary).toContain("changed 1 file (+1 −0): health.txt");
    expect(second.item.result?.summary).not.toContain("already exists");
  });

  it("reports no changes when the agent changed nothing", async () => {
    const box = await sandbox();
    await stubAgent(box, "claude", 'echo "nothing to do"');
    const { item } = await joinAndWork(box, ["--submit", "push"]);
    expect(item.result?.summary.split("\n")[2]).toBe("no changes");
    expect(item.result?.submit).toMatchObject({ method: "push", state: "skipped" });
    expect(await remoteHas(box, "main")).toBe(
      await gitIn(box.repo, ["rev-parse", "HEAD"], box.env),
    );
  });

  it("a pre-dirty tree is left alone; only files changed by the run are listed, annotated", async () => {
    const box = await sandbox();
    // Dirty before the run: an edit the agent will touch again, and one it will not.
    await writeFile(path.join(box.repo, "notes.txt"), "one\nmine\n");
    await writeFile(path.join(box.repo, "README.md"), "app, edited by me\n");
    await writeFile(path.join(box.repo, "scratch.txt"), "untracked\n");
    const { item } = await joinAndWork(box, ["--submit", "none"]);
    // Nothing was stashed or reset: the human's edit to README.md and scratch.txt survive.
    expect(await readFile(path.join(box.repo, "README.md"), "utf8")).toBe("app, edited by me\n");
    expect(await readFile(path.join(box.repo, "scratch.txt"), "utf8")).toBe("untracked\n");
    expect(item.result?.summary.split("\n")[2]).toBe(
      "changed 2 files (+3 −1): health.txt, notes.txt (was already modified)",
    );
  });

  it("a non-zero exit is a FAILED block with one cause, one fix and the whole text", async () => {
    const box = await sandbox();
    const noise = Array.from({ length: 40 }, (_, n) => `trace line ${n} ${"x".repeat(20)}`);
    await stubAgent(
      box,
      "claude",
      `printf "half\\n" > half.txt\n${noise.map((line) => `echo "${line}"`).join("\n")}\nexit 3`,
    );
    const { item, events } = await joinAndWork(box, ["--submit", "push"]);
    expect(item.result?.checks).toEqual([{ name: "agent", status: "fail" }]);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "failed", branch: "main" });
    const summary = item.result?.summary ?? "";
    expect(summary).toContain("cause: agent claude exited 3");
    expect(summary).toMatch(/\nfix: read the agent's output/);
    expect(summary).toContain("changed 1 file (+1 −0): half.txt");
    const log = path.join(box.env.SKEP_HOME ?? "", "session", "last-error.log");
    expect(summary).toContain(`full text: ${log}`);
    expect(await readFile(log, "utf8")).toContain("trace line 39");
    const block = events.find((e) => e.kind === "item-failed")?.message ?? "";
    expect(block).toMatch(/^I-1 FAILED · vps \(app\) · claude · \d+s\n/);
    expect(block.length).toBeGreaterThan(600);
    expect(block).toContain("trace line 39");
    expect(events.some((e) => e.kind === "item-result")).toBe(false);
    expect(events.find((e) => e.kind === "intent-failed")?.message).toContain("0 done · 1 failed");
  });

  it("reports the changed files as a structured list to a v2 master (ORCH-6)", async () => {
    const box = await sandbox();
    // The default stub edits notes.txt and creates health.txt.
    const { item } = await joinAndWork(box, ["--submit", "none"]);
    expect(item.result?.changed).toEqual({
      files: [
        { path: "health.txt", change: "added", added: 1, removed: 0 },
        { path: "notes.txt", change: "modified", added: 2, removed: 1 },
      ],
      total: 2,
      partial: false,
    });
  });

  it("keeps the agent's live output on the device unless --share-output (ORCH-6)", async () => {
    const box = await sandbox();
    await stubAgent(box, "claude", 'echo "compiling"\necho "all green"');
    const quiet = await joinAndWork(box, ["--submit", "none"]);
    expect(quiet.events.some((e) => e.kind === "peer-output" || e.kind === "share-output")).toBe(
      false,
    );
    expect(quiet.run.stdout).toContain('"shareOutput":false');

    const shared = await joinAndWork(box, ["--submit", "none", "--share-output"]);
    expect(shared.run.stdout).toContain('"shareOutput":true');
    expect(shared.events.find((e) => e.kind === "share-output")?.message).toContain(
      "shares its live agent output",
    );
    const output = shared.events
      .filter((e) => e.kind === "peer-output")
      .map((e) => e.message)
      .join("\n");
    expect(output).toContain("compiling");
    expect(output).toContain("all green");
  });

  it("a missing agent binary at run time names the CLI and the fix", async () => {
    const box = await sandbox();
    const dir = await home();
    const c = capture(dir, { env: box.env, cwd: box.repo, paths: skepPaths(dir) });
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "none" });
    if (worker.agent !== undefined) worker.agent.cli = "codex";
    const result = await workItem(worker, ITEM);
    expect(result.checks).toEqual([{ name: "agent", status: "fail" }]);
    expect(result.summary).toContain("cause: agent CLI codex not found on PATH");
    expect(result.summary).toContain("fix: install codex");
  });

  it("joins in auto mode by default: no per-item question before the run", async () => {
    const box = await sandbox();
    const { item, run } = await joinAndWork(box, ["--submit", "none"]);
    expect(run.stderr).not.toContain("Run item");
    expect(run.stdout).toContain('"control":"auto"');
    expect(run.stdout).toContain('"agent":{"cli":"claude","source":"PATH","view":"native"}');
    expect(item.result?.submit).toMatchObject({ method: "none", state: "local" });
  });

  it("--manual asks before each item; Enter runs it", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("\n");
    const { item, run } = await joinAndWork(box, ["--manual", "--submit", "none"], { stdin });
    expect(run.stdout).toContain('"control":"manual"');
    expect(run.stderr).toContain("Run item I-1 (app): add a health check? [Y/n]");
    expect(item.result?.submit).toMatchObject({ method: "none", state: "local" });
  });

  it("--manual: n declines the item and runs nothing", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("n\n");
    const { item } = await joinAndWork(box, ["--manual", "--submit", "push"], { stdin });
    expect(item.result?.checks).toEqual([{ name: "peer", status: "skip" }]);
    expect(item.result?.submit).toEqual({ method: "push", state: "skipped", branch: "main" });
    expect(item.result?.summary).toContain("declined on this device (manual mode)");
    await expect(stat(path.join(box.env.HOME ?? "", "claude-called"))).rejects.toThrow();
  });

  it("--manual cannot be combined with --ui", async () => {
    const box = await sandbox();
    setJoinViewFactory(() => recordingView().view);
    try {
      const c = capture(box.home, { env: box.env, cwd: box.repo });
      const argv = ["--machine", "session", "join", "--code", "123456789012", "--host", "h:1"];
      expect(await runCli([...argv, "--ui", "--manual"], c.ctx)).toBe(2);
      expect(JSON.parse(c.stdout).error.message).toMatch(/--manual cannot be combined with --ui/);
    } finally {
      setJoinViewFactory(null);
    }
  });

  it.each(["committed", "unborn", "non-git"] as const)(
    "keeps a same-device peer in a different %s project connected and working (SAME-CB)",
    async (project) => {
      const box = await sandbox();
      const peerDir = path.join(box.home, "proj-b");
      if (project === "committed") {
        await gitIn(box.home, ["clone", "--quiet", box.repo, peerDir], box.env);
      } else {
        await mkdir(peerDir);
        if (project === "unborn") await gitIn(peerDir, ["init", "--quiet"], box.env);
      }
      await writeFile(path.join(peerDir, "peer.txt"), "peer project\n");
      if (project !== "non-git") await gitIn(peerDir, ["add", "peer.txt"], box.env);
      const head =
        project === "committed"
          ? await gitIn(peerDir, ["rev-parse", "HEAD"], box.env)
          : "0".repeat(40);
      await stubAgent(box, "claude", 'printf "x\\n" >> peer.txt\necho "Appended x."');
      const master = await startMaster({
        device: "mac",
        repo: "proj-a",
        controlToken: TOKEN,
        acceptJoin: async () => true,
        onJoinCode: () => {},
      });
      const log = recordingView();
      const warnings: string[] = [];
      const say = vi.fn();
      const closed: string[] = [];
      let joined: JoinFlow | undefined;
      try {
        const code = master.status().joinCode;
        if (code === null) throw new Error("master has no join code");
        const peerHome = path.join(box.home, "peer-skep");
        const c = capture(peerHome, {
          env: { ...box.env, SKEP_HOME: peerHome },
          paths: skepPaths(peerHome),
          cwd: peerDir,
          sessionApi: {
            startMaster,
            connectSub: (options) => {
              const toMaster = new PassThrough();
              const toPeer = new PassThrough();
              master.attach(Duplex.from({ readable: toMaster, writable: toPeer }), {
                address: HOST,
                family: "IPv4",
              });
              const { target: _target, ...sub } = options;
              return connectSub({
                ...sub,
                stream: Duplex.from({ readable: toPeer, writable: toMaster }),
              });
            },
          },
        });
        joined = await joinSessionFlow(
          c.ctx,
          {
            host: "example.com:7419",
            code,
            repo: "proj-a",
            device: "mac",
            role: "coding",
            submit: "none",
          },
          {
            say,
            ask: async () => null,
            warn: (message) => warnings.push(message),
            createView: () => log.view,
          },
        );
        expect(joined.dir).toBe(peerDir);
        void joined.closed.then(({ reason }) => closed.push(reason));
        for (let index = 0; index < 2; index++) {
          await expect(master.submitIntent("add a health check")).resolves.toEqual({
            intentId: `intent-${index + 1}`,
          });
          await vi.waitFor(
            () => expect(master.status().intents[index]?.items[0]?.state).toBe("done"),
            { timeout: 5_000 },
          );
          const item = master.status().intents[index]?.items[0];
          expect(item).toMatchObject({
            repo: "proj-a",
            assignee: joined.handle.peerId,
            datalistEntries: project === "committed" ? 3 : project === "unborn" ? 1 : 0,
            result: {
              repo: "proj-a",
              baseSha: head,
              headSha: head,
              checks: [{ name: "none", status: "skip" }],
              submit: { method: "none", state: "local" },
            },
          });
          // A repo without HEAD or no repo at all now runs the agent in place too.
          expect(item?.result?.summary).toContain("changed 1 file (+1 −0): peer.txt");
          expect(master.status().peers).toMatchObject([
            { peerId: joined.handle.peerId, device: "mac", repo: "proj-a", head },
          ]);
          expect(closed).toEqual([]);
        }
        expect(say.mock.calls.some(([event]) => event.event === "session-error")).toBe(false);
        expect(warnings.length).toBe(project === "committed" ? 0 : project === "unborn" ? 2 : 4);
      } finally {
        await joined?.close();
        await master.close();
      }
    },
  );
});

describe("agent resolution at join", () => {
  async function stubs(names: readonly string[]): Promise<string> {
    const dir = await home();
    for (const name of names) await writeFile(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
    return dir;
  }

  it("honours flag > /agent > SKEP_AGENT_CLI > AGENT.md > PATH, first of claude, codex, pi", async () => {
    const bin = await stubs(["claude", "codex", "pi"]);
    const dir = await home();
    const warn = vi.fn();
    const env = { PATH: bin, SKEP_AGENT_CLI: "codex" };
    await writeFile(path.join(dir, "AGENT.md"), AGENT_MD("pi"));
    expect(await resolveAgentCli({ flag: "pi", setting: "claude", env, dir, warn })).toEqual({
      cli: "pi",
      source: "--agent",
    });
    expect(await resolveAgentCli({ setting: "claude", env, dir, warn })).toEqual({
      cli: "claude",
      source: "/agent",
    });
    expect(await resolveAgentCli({ env, dir, warn })).toEqual({
      cli: "codex",
      source: "SKEP_AGENT_CLI",
    });
    expect(await resolveAgentCli({ env: { PATH: bin }, dir, warn })).toEqual({
      cli: "pi",
      source: "AGENT.md",
    });
    const empty = await home();
    expect(await resolveAgentCli({ env: { PATH: bin }, dir: empty, warn })).toEqual({
      cli: "claude",
      source: "PATH",
    });
    const onlyPi = await stubs(["pi"]);
    expect(await resolveAgentCli({ env: { PATH: onlyPi }, dir: empty, warn })).toEqual({
      cli: "pi",
      source: "PATH",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("an explicit choice must be installed; a broken AGENT.md is skipped with a warning", async () => {
    const bin = await stubs(["codex"]);
    const dir = await home();
    await expect(
      resolveAgentCli({ flag: "claude", env: { PATH: bin }, dir, warn: () => {} }),
    ).rejects.toThrow(/agent claude \(from --agent\) is not on PATH\nfix: install claude/);
    await expect(
      resolveAgentCli({ env: { PATH: bin, SKEP_AGENT_CLI: "gpt" }, dir, warn: () => {} }),
    ).rejects.toThrow(/SKEP_AGENT_CLI=gpt is not one of claude, codex, pi/);
    await writeFile(path.join(dir, "AGENT.md"), "not front matter\n");
    const warn = vi.fn();
    expect(await resolveAgentCli({ env: { PATH: bin }, dir, warn })).toEqual({
      cli: "codex",
      source: "PATH",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignoring AGENT.md"));
  });

  it("no agent anywhere: join fails with the actionable message and never connects", async () => {
    const box = await sandbox();
    await rm(path.join(box.bin, "claude"));
    const fake = fakeApi();
    const c = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
    const argv = ["session", "join", "--code", "123456789012", "--host", "h:1", "--repo", "app"];
    expect(await runCli(argv, c.ctx)).toBe(2);
    expect(c.stderr).toContain(
      "no agent CLI found (looked for claude, codex, pi on PATH)\n" +
        "fix: install one, or pass --agent <claude|codex|pi>",
    );
    expect(fake.calls.sub).toHaveLength(0);
  });

  it("joins with only --code and --host: repo and device default to checkout and hostname", async () => {
    const hostname = vi.spyOn(os, "hostname").mockReturnValue("Kris-MacBook.local");
    try {
      const box = await sandbox();
      const fake = fakeApi();
      const c = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
      const argv = ["session", "join", "--code", "1234-5678-9012", "--host", "10.0.0.5:7419"];
      expect(await runCli(argv, c.ctx)).toBe(0);
      const options = fake.calls.sub[0];
      expect(options?.code).toBe("123456789012");
      expect(options?.target).toEqual({ host: "10.0.0.5", port: 7419 });
      // The device rides the handshake; the repo rides the peer's description (no wire change).
      expect(options?.device).toBe("kris-macbook-local");
      const described = await options?.describe();
      expect(described?.repo).toBe(path.basename(box.repo));
      expect(described?.role).toBe("coding");
    } finally {
      hostname.mockRestore();
    }
  });

  it("joins without --repo outside a git checkout fails with the actionable fix", async () => {
    const fake = fakeApi();
    const dir = await home();
    const c = capture(dir, { cwd: dir, sessionApi: fake.api });
    const argv = ["--machine", "session", "join", "--code", "123456789012", "--host", "h:1"];
    expect(await runCli(argv, c.ctx)).toBe(2);
    const error = JSON.parse(c.stdout).error;
    expect(error.code).toBe("repo_required");
    expect(error.message).toContain("not inside a git repository; pass --repo <name>");
    expect(fake.calls.sub).toHaveLength(0);
  });

  it("joins with no AGENT.md and no --role-dir, naming the agent and the folder", async () => {
    const box = await sandbox();
    const fake = fakeApi();
    const c = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
    const argv = ["session", "join", "--code", "123456789012", "--host", "h:1", "--repo", "app"];
    expect(await runCli(argv, c.ctx)).toBe(0);
    expect(c.stdout).toContain(
      `agent: claude (found on PATH) · mode: edits this folder directly (${box.repo})`,
    );
  });

  it("legacy --agent pty is refused with its replacement, before connecting", async () => {
    const box = await sandbox();
    const fake = fakeApi();
    const c = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
    const argv = ["session", "join", "--code", "123456789012", "--host", "h:1", "--repo", "app"];
    expect(await runCli([...argv, "--agent", "pty"], c.ctx)).toBe(2);
    expect(c.stderr).toContain("--agent pty is now --view pty; --agent takes the agent CLI");
    expect(fake.calls.sub).toHaveLength(0);
    // --role-dir is still tolerated: old paste lines keep working.
    const ok = capture(box.home, { env: box.env, cwd: box.repo, sessionApi: fake.api });
    expect(await runCli([...argv, "--view", "pty", "--role-dir", "/x"], ok.ctx)).toBe(0);
    expect(ok.stderr).toContain("skep: --role-dir is ignored; AGENT.md is no longer required\n");
    expect(ok.stdout).toContain("agent: claude (found on PATH) (pty view)");
  });

  it("device.toml [agent] cli is the /agent setting: after --agent, before SKEP_AGENT_CLI", async () => {
    const bin = await home();
    for (const name of ["claude", "codex", "pi"]) {
      await writeFile(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    }
    const dir = await home();
    const toml = path.join(dir, "device.toml");
    const env = { PATH: bin, SKEP_AGENT_CLI: "codex" };
    const warn = vi.fn();
    await writeFile(toml, 'schema = "skep.device/v1"\n\n[submit]\nmethod = "none"\n');
    expect(await resolveAgentCli({ deviceToml: toml, env, dir, warn })).toEqual({
      cli: "codex",
      source: "SKEP_AGENT_CLI",
    });
    await saveAgentSetting(toml, "pi");
    expect(await readFile(toml, "utf8")).toBe(
      'schema = "skep.device/v1"\n\n[submit]\nmethod = "none"\n\n[agent]\ncli = "pi"\n',
    );
    expect(await resolveAgentCli({ deviceToml: toml, env, dir, warn })).toEqual({
      cli: "pi",
      source: "/agent",
    });
    expect(await resolveAgentCli({ flag: "claude", deviceToml: toml, env, dir, warn })).toEqual({
      cli: "claude",
      source: "--agent",
    });
    // Saving again replaces the key in place; the submit policy still parses.
    await saveAgentSetting(toml, "claude");
    expect(await loadAgentSetting(toml)).toBe("claude");
    expect((await readFile(toml, "utf8")).match(/\[agent\]/g)).toHaveLength(1);
    expect(await loadSubmitPolicy(toml)).toEqual({ method: "none", host: "github" });
    await writeFile(toml, '[agent]\ncli = "gpt"\n');
    expect(await loadAgentSetting(toml, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignoring the [agent] setting"));
  });

  it("--view dry runs nothing, commits nothing and reports a failed-class DRY RUN", async () => {
    const box = await sandbox();
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const fake = fakeRuntime();
    const { item, events } = await joinAndWork(box, ["--submit", "none", "--view", "dry"], {
      agentRuntime: fake.runtime,
    });
    expect(fake.loads).toBe(0);
    await expect(stat(path.join(box.env.HOME ?? "", "claude-called"))).rejects.toThrow();
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe("");
    expect(item.result?.checks).toEqual([{ name: "agent", status: "fail" }]);
    expect(item.result?.summary).toContain(DRY_RUN_SUMMARY);
    expect(events.some((e) => e.kind === "item-failed")).toBe(true);
  });

  it("the dry marker and its fake-success text are gone from src/", async () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const banned = [`dry run: committed the ${"session marker"}`, `.skep-${"session-item"}`];
    const files = await readdir(src, { recursive: true });
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(path.join(src, file), "utf8");
      for (const needle of banned) expect(text, file).not.toContain(needle);
    }
  });
});

describe("items on one peer run strictly one at a time", () => {
  it("a second item waits for the first agent to exit", async () => {
    const box = await sandbox();
    const order = path.join(box.env.HOME ?? "", "order.log");
    await stubAgent(
      box,
      "claude",
      `echo "start $SKEP_SESSION_ITEM" >> "${order}"\n${realSleep} 0.3\n` +
        `echo "end $SKEP_SESSION_ITEM" >> "${order}"`,
    );
    const fake = fakeApi();
    const open = deferred();
    const connect = fake.api.connectSub;
    // A session that stays up while both items run.
    fake.api.connectSub = async (options) => ({
      ...(await connect(options)),
      closed: open.promise.then(() => ({ reason: "test" })),
      close: async () => open.resolve(),
    });
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      sessionApi: fake.api,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    const flow = await joinSessionFlow(
      c.ctx,
      { code: "123456789012", host: "h:1", repo: "app", role: "coding", submit: "none" },
      {
        say: () => {},
        ask: async () => null,
        warn: () => {},
        createView: () => recordingView().view,
      },
    );
    const sub = fake.calls.sub[0];
    if (sub === undefined) throw new Error("no join");
    const results = await Promise.all([
      sub.onItem({ ...ITEM, itemId: "I-1" }),
      sub.onItem({ ...ITEM, itemId: "I-2" }),
    ]);
    expect((await readFile(order, "utf8")).trim().split("\n")).toEqual([
      "start I-1",
      "end I-1",
      "start I-2",
      "end I-2",
    ]);
    for (const result of results)
      expect(result?.checks).toEqual([{ name: "none", status: "skip" }]);
    await flow.close();
  });
});

describe("submit modes on the item's delta", () => {
  it("commit commits only the item's files on the current branch", async () => {
    const box = await sandbox();
    await writeFile(path.join(box.repo, "README.md"), "my own edit\n");
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item } = await joinAndWork(box, ["--submit", "commit"]);
    const head = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    expect(head).not.toBe(base);
    expect(item.result?.headSha).toBe(head);
    // The wire has no commit method: it travels as none/local, the summary says commit.
    expect(item.result?.submit).toEqual({ method: "none", state: "local", branch: "main" });
    expect(item.result?.summary.split("\n")[0]).toBe(
      `submit commit local ${head.slice(0, 7)} on main`,
    );
    expect(await gitIn(box.repo, ["show", "--name-only", "--format=", "HEAD"], box.env)).toBe(
      "health.txt\nnotes.txt",
    );
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe("M README.md");
    expect(await remoteHas(box, "main")).toBe(base);
  });

  it("push commits the item's files and pushes the current branch", async () => {
    const box = await sandbox();
    const { item } = await joinAndWork(box, ["--submit", "push"]);
    const head = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    expect(item.result?.submit).toEqual({ method: "push", state: "pushed", branch: "main" });
    expect(await remoteHas(box, "main")).toBe(head);
  });

  it("a push that fails is a failed outcome, not a crash", async () => {
    const box = await sandbox();
    await rm(box.bare, { recursive: true, force: true });
    const { item, exit } = await joinAndWork(box, ["--submit", "push"]);
    expect(exit).toBe(0);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "failed" });
  });

  it("uses the device.toml policy when --submit is absent", async () => {
    const box = await sandbox();
    await mkdir(box.env.SKEP_HOME ?? "", { recursive: true });
    await writeFile(
      path.join(box.env.SKEP_HOME ?? "", "device.toml"),
      '[submit]\nmethod = "pr"\nhost = "git"\n',
    );
    const { item } = await joinAndWork(box, []);
    // host = "git" forces push.
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pushed" });
  });

  it("without device.toml or --submit, defaults to none: edits stay, no submit prompt", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.end();
    const { item, run } = await joinAndWork(box, [], { stdin });
    expect(item.result?.submit).toEqual({ method: "none", state: "local", branch: "main" });
    expect(run.stderr).not.toContain("Submit this item?");
  });

  it("pr without gh on PATH stays local: no branch, no commit, no push", async () => {
    const box = await sandbox();
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item } = await joinAndWork(box, ["--submit", "pr"]);
    expect(item.result?.submit).toMatchObject({ method: "pr", state: "local", branch: "main" });
    expect(item.result?.summary).toContain("gh is not on PATH; nothing was committed");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
    expect(await gitIn(box.repo, ["branch", "--list", "skep/*"], box.env)).toBe("");
  });

  it("pr creates skep/<item>-<slug> at submit time without touching the folder or branch", async () => {
    const box = await sandbox();
    await writeFile(
      path.join(box.bin, "gh"),
      `#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/gh-args.txt"\necho "https://github.com/o/r/pull/7"\n`,
      { mode: 0o755 },
    );
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item } = await joinAndWork(box, ["--submit", "pr"]);
    const branch = "skep/I-1-add-a-health-check";
    expect(item.result?.submit).toEqual({
      method: "pr",
      state: "opened",
      branch,
      url: "https://github.com/o/r/pull/7",
      number: 7,
    });
    // The folder keeps the edits on its own branch; the PR branch holds a copy on top of HEAD.
    expect(await gitIn(box.repo, ["rev-parse", "--abbrev-ref", "HEAD"], box.env)).toBe("main");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe(
      "M notes.txt\n?? health.txt",
    );
    expect(await gitIn(box.repo, ["rev-parse", `${branch}^`], box.env)).toBe(base);
    expect(await gitIn(box.repo, ["show", `${branch}:health.txt`], box.env)).toBe("ok");
    expect(await remoteHas(box, branch)).toBe(
      await gitIn(box.repo, ["rev-parse", branch], box.env),
    );
    const args = await readFile(path.join(box.env.HOME ?? "", "gh-args.txt"), "utf8");
    expect(args).toContain(`--head\n${branch}\n--base\nmain\n`);
  });

  it("a failing check is reported, the edits stay, nothing is pushed", async () => {
    const box = await sandbox();
    await mkdir(path.join(box.repo, ".skep"));
    await writeFile(
      path.join(box.repo, ".skep", "checks.toml"),
      'schema = "skep.checks/v1"\n[checks.lint]\nargv = ["git", "--version"]\n' +
        '[checks.unit]\nargv = ["git", "no-such-subcommand"]\n',
    );
    const who = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
    await gitIn(box.repo, ["add", "."], box.env);
    await gitIn(box.repo, [...who, "commit", "--quiet", "-m", "checks"], box.env);
    const head = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item } = await joinAndWork(box, ["--submit", "push"]);
    expect(item.result?.checks).toEqual([{ name: "unit", status: "fail" }]);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "skipped" });
    expect(item.result?.summary).toContain("checks failed; not submitted");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(head);
  });

  it("a passing check is recorded before the push", async () => {
    const box = await sandbox();
    await mkdir(path.join(box.repo, ".skep"));
    await writeFile(
      path.join(box.repo, ".skep", "checks.toml"),
      'schema = "skep.checks/v1"\n[checks.lint]\nargv = ["git", "--version"]\n',
    );
    const who = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
    await gitIn(box.repo, ["add", "."], box.env);
    await gitIn(box.repo, [...who, "commit", "--quiet", "-m", "checks"], box.env);
    const { item } = await joinAndWork(box, ["--submit", "push"]);
    expect(item.result?.checks).toEqual([{ name: "lint", status: "pass" }]);
    expect(item.result?.submit).toMatchObject({ state: "pushed" });
  });

  it("device.toml method ask still asks", async () => {
    const box = await sandbox();
    await mkdir(box.env.SKEP_HOME ?? "", { recursive: true });
    await writeFile(
      path.join(box.env.SKEP_HOME ?? "", "device.toml"),
      '[submit]\nmethod = "ask"\n',
    );
    const stdin = new PassThrough();
    stdin.end();
    const { item, run } = await joinAndWork(box, [], { stdin });
    expect(run.stderr).toContain("Submit this item? [commit/push/pr/mr/none/skip]");
    expect(item.result?.submit).toMatchObject({ method: "ask", state: "skipped" });
  });

  it("ask: shows the changed files, then a typed answer submits", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("push\n");
    const { item, run } = await joinAndWork(box, ["--submit", "ask"], { stdin });
    expect(run.stderr).toContain("item I-1 changed 2 files (+3 −1): health.txt, notes.txt");
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pushed" });
  });

  it("ask: skip leaves the edits; skep session submit commits the recorded delta later", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.end();
    const { item } = await joinAndWork(box, ["--submit", "ask"], { stdin });
    expect(item.result?.submit).toEqual({ method: "ask", state: "skipped", branch: "main" });
    await writeFile(path.join(box.repo, "README.md"), "unrelated\n");

    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    const argv = ["--machine", "session", "submit", "I-1", "--method", "push"];
    expect(await runCli(argv, c.ctx)).toBe(0);
    const out = JSON.parse(c.stdout).result;
    expect(out.submit).toEqual({ method: "push", state: "pushed", branch: "main" });
    expect(out.files).toEqual(["health.txt", "notes.txt"]);
    expect(await gitIn(box.repo, ["show", "--name-only", "--format=", "HEAD"], box.env)).toBe(
      "health.txt\nnotes.txt",
    );
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe("M README.md");
  });

  it("submit on a legacy skep/session/* branch says so and deletes nothing", async () => {
    const box = await sandbox();
    await gitIn(box.repo, ["branch", "skep/session/I-3-e1"], box.env);
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    expect(await runCli(["session", "submit", "I-3", "--method", "push"], c.ctx)).not.toBe(0);
    expect(c.stderr).toContain("skep/session/I-3-e1 is a legacy branch from skep 0.1.x");
    expect(c.stderr).toContain("git push origin skep/session/I-3-e1");
    expect(await gitIn(box.repo, ["branch", "--list", "skep/session/*"], box.env)).toContain(
      "skep/session/I-3-e1",
    );
    expect(await remoteHas(box, "skep/session/I-3-e1")).toBeNull();
  });

  it("a new peer's result stays valid on the unchanged wire for any master", async () => {
    const box = await sandbox();
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "commit" });
    const result = await workItem(worker, ITEM);
    expect(SubResultSchema.safeParse(result).success).toBe(true);
    // An old master shows the first line as before: a submit line.
    expect(result.summary.split("\n")[0]).toMatch(/^submit commit local [0-9a-f]{7} on main$/);
  });
});

describe("session submit policy", () => {
  it("defaults to none; reads method; host git forces push; a bad file falls back", async () => {
    const dir = await home();
    const file = path.join(dir, "device.toml");
    expect(await loadSubmitPolicy(file)).toEqual({ method: "none", host: "github" });
    await writeFile(file, 'schema = "skep.device/v1"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "none", host: "github" });
    await writeFile(file, '[submit]\nmethod = "mr"\nhost = "gitlab"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "mr", host: "gitlab" });
    await writeFile(file, '[submit]\nmethod = "commit"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "commit", host: "github" });
    await writeFile(file, '[submit]\nhost = "git"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "push", host: "git" });
    const warnings: string[] = [];
    await writeFile(file, '[submit]\nmethod = "fax"\n');
    expect(await loadSubmitPolicy(file, (w) => warnings.push(w))).toEqual({
      method: "none",
      host: "github",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("falling back to none");
    await writeFile(file, "[submit\n");
    expect(await loadSubmitPolicy(file, (w) => warnings.push(w))).toEqual({
      method: "none",
      host: "github",
    });
    await writeFile(file, '[submit]\nmethod = "ask"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "ask", host: "github" });
  });
});

describe("session undo", () => {
  it("restores the files of an item and removes the ones it created", async () => {
    const box = await sandbox();
    await joinAndWork(box, ["--submit", "none"]);
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    expect(await runCli(["session", "undo", "I-1"], c.ctx)).toBe(0);
    expect(c.stdout).toBe(`undid I-1 in ${box.repo}: restored notes.txt; removed health.txt\n`);
    expect(await readFile(path.join(box.repo, "notes.txt"), "utf8")).toBe("one\ntwo\n");
    await expect(stat(path.join(box.repo, "health.txt"))).rejects.toThrow();
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe("");
    // Undoing twice is refused: there is nothing recorded to put back any more.
    const again = capture(box.home, { env: box.env, cwd: box.repo, paths: c.ctx.paths });
    expect(await runCli(["session", "undo", "I-1"], again.ctx)).not.toBe(0);
    expect(again.stderr).toMatch(/I-1 \(session session-[0-9a-f]+\) was already undone/);
  });

  it("refuses when a file changed again after the item, unless --force", async () => {
    const box = await sandbox();
    await writeFile(path.join(box.repo, "notes.txt"), "one\nmine\n");
    await joinAndWork(box, ["--submit", "none"]);
    await writeFile(path.join(box.repo, "health.txt"), "edited after the item\n");
    const paths = skepPaths(box.env.SKEP_HOME ?? "");
    const c = capture(box.home, { env: box.env, cwd: box.repo, paths });
    expect(await runCli(["session", "undo", "I-1"], c.ctx)).not.toBe(0);
    expect(c.stderr).toMatch(
      /cannot undo I-1 \(session \S+\): health.txt changed again after the item/,
    );
    expect(c.stderr).toContain("Nothing was changed; pass --force");
    expect(await readFile(path.join(box.repo, "health.txt"), "utf8")).toBe(
      "edited after the item\n",
    );
    const forced = capture(box.home, { env: box.env, cwd: box.repo, paths });
    expect(await runCli(["session", "undo", "I-1", "--force"], forced.ctx)).toBe(0);
    expect(forced.stdout).toContain("overwrote later edits in health.txt (--force)");
    // The pre-existing edit comes back, not HEAD's content.
    expect(await readFile(path.join(box.repo, "notes.txt"), "utf8")).toBe("one\nmine\n");
    await expect(stat(path.join(box.repo, "health.txt"))).rejects.toThrow();
  });

  it("an unknown item is refused with where it looked", async () => {
    const dir = await home();
    const c = capture(dir, { paths: skepPaths(dir) });
    expect(await runCli(["session", "undo", "I-9"], c.ctx)).not.toBe(0);
    expect(c.stderr).toContain("no recorded changes for I-9 in this project");
  });
});

// ---------------------------------------------------------------------------------------------
// SK-621: live agent view. Fake PtyRunner and AgentSessionBackend; the native path runs a stub
// CLI from the sandbox PATH. No real agent CLI, PTY or herdr.

const AGENT_MD = (cli: string): string =>
  [
    "---",
    "schema: skep.agent/v1",
    "role: coding",
    `agent_cli: ${cli}`,
    'cli_version: "1.0.0"',
    "repos: [app]",
    "capabilities: []",
    "---",
    "Write code.",
    "",
  ].join("\n");

/** Built from pieces so no secret-shaped literal sits in the repo. */
const PLANTED = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const ESC = "\u001b";
const PROMPT =
  "add a health check\n\n" +
  "Work directly in the current directory. End with a brief summary of what you changed.\n";

class FakeSessionError extends Error {
  constructor(
    message: string,
    readonly fallbackSafe: boolean,
  ) {
    super(message);
  }
}

class FakePtyUnavailableError extends Error {}

/** Mirrors SK-620's stripTerminalControls closely enough for the tests: CSI, OSC and CR. */
function fakeStrip(text: string): string {
  return text
    .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}\\][^\\u0007]*\\u0007`, "g"), "")
    .replace(/\r/g, "");
}

interface FakeRuntime {
  runtime: () => Promise<AgentRuntime>;
  ptyRuns: PtyRunOptions[];
  herdrCalls: string[];
  loads: number;
}

function fakeRuntime(
  opts: {
    pty?: (run: PtyRunOptions) => Promise<PtyRunResult>;
    herdr?: Partial<AgentSessionBackend>;
  } = {},
): FakeRuntime {
  const fake: FakeRuntime = {
    ptyRuns: [],
    herdrCalls: [],
    loads: 0,
    runtime: async () => {
      fake.loads += 1;
      return runtime;
    },
  };
  const call = (name: string, detail = ""): void => {
    fake.herdrCalls.push(detail === "" ? name : `${name} ${detail}`);
  };
  const backend: AgentSessionBackend = {
    name: "herdr",
    probe: async () => {
      call("probe");
      return { protocol: 22, schemaVersion: 1 };
    },
    start: async (start) => {
      call("start", `${start.name} ${start.kind} ${start.cwd}`);
      return {
        name: start.name,
        paneId: "pane-1",
        focusCommand: ["herdr", "agent", "focus", start.name],
      };
    },
    prompt: async (_h, text) => call("prompt", JSON.stringify(text)),
    wait: async () => {
      call("wait");
      return "done";
    },
    read: async (_h, read) => {
      call("read", String(read?.lines));
      return "agent says hello";
    },
    focus: async () => call("focus"),
    close: async () => call("close"),
  };
  for (const [key, value] of Object.entries(opts.herdr ?? {})) {
    const name = key as keyof AgentSessionBackend;
    const original = backend[name];
    if (typeof value !== "function" || typeof original !== "function") continue;
    (backend as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      call(name);
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
  const runtime: AgentRuntime = {
    ptyRunner: () => ({
      run: async (run) => {
        fake.ptyRuns.push(run);
        if (opts.pty !== undefined) return opts.pty(run);
        await writeFile(path.join(run.cwd, "feature.txt"), "done\n");
        const transcript = Buffer.from(`${ESC}[32mworking${ESC}[0m\r\nfinished\r\n`);
        await writeFile(run.transcriptPath, transcript, { mode: 0o600 });
        return { exit: { code: 0, signal: null }, aborted: false, transcript };
      },
    }),
    herdrBackend: () => backend,
    stripTerminalControls: fakeStrip,
    isPtyUnavailable: (error) => error instanceof FakePtyUnavailableError,
  };
  return fake;
}

const ITEM = {
  itemId: "I-7",
  repo: "app",
  assignee: "P-1",
  epoch: 1,
  title: "add a health check",
  datalistEntries: 0,
};

interface ViewLog {
  view: JoinView;
  events: string[];
  models: JoinViewModel[];
}

function recordingView(choice: "commit" | "pr" | "mr" | "push" | "none" | null = null): ViewLog {
  const events: string[] = [];
  const models: JoinViewModel[] = [];
  return {
    events,
    models,
    view: {
      update: (model) => {
        models.push(model);
        events.push(`update:${model.agent?.state ?? "-"}`);
      },
      chooseSubmit: async (model) => {
        events.push(`choose:${model.item?.itemId}`);
        return choice;
      },
      suspend: async () => {
        events.push("suspend");
      },
      resume: () => events.push("resume"),
      close: () => events.push("close"),
    },
  };
}

const workerAborts: AbortController[] = [];
afterEach(() => {
  for (const abort of workerAborts.splice(0)) abort.abort();
});

function itemWorker(
  box: Sandbox,
  c: ReturnType<typeof capture>,
  view: AgentView,
  fake: FakeRuntime,
  extra: Partial<ItemWorker> = {},
): ItemWorker & { notes: Notification[] } {
  const notes: Notification[] = [];
  // Ends a blocked agent's background watch with the test (R4).
  const abort = new AbortController();
  workerAborts.push(abort);
  return {
    ctx: c.ctx,
    dir: box.repo,
    signal: abort.signal,
    method: "push",
    ask: async () => null,
    agent: {
      view,
      cli: "claude",
      runtime: fake.runtime,
      journal: path.join(box.home, "journal"),
      notify: async (note) => notes.push(note),
    },
    notes,
    ...extra,
  };
}

describe("agent strategy selection", () => {
  it("native by default; --view wins; SKEP_SESSION_VIEW honoured; SKEP_SESSION_EXEC gone", () => {
    expect(selectAgentView(undefined, {})).toBe("native");
    expect(selectAgentView(undefined, { SKEP_SESSION_VIEW: "herdr" })).toBe("herdr");
    expect(selectAgentView(undefined, { SKEP_SESSION_VIEW: "nonsense" })).toBe("native");
    expect(selectAgentView(undefined, { SKEP_SESSION_EXEC: "1" })).toBe("native");
    for (const flag of ["dry", "pty", "herdr", "native"] as const) {
      expect(selectAgentView(flag, { SKEP_SESSION_EXEC: "1", SKEP_SESSION_VIEW: "herdr" })).toBe(
        flag,
      );
    }
  });

  it("--agent takes a CLI; legacy view names are refused with their replacement", () => {
    expect(parseAgentFlag(undefined)).toEqual({});
    expect(parseAgentFlag("codex")).toEqual({ cli: "codex" });
    expect(() => parseAgentFlag("native")).toThrow(/--agent native is now --view native/);
    expect(() => parseAgentFlag("gpt")).toThrow(/--agent must be claude, codex, pi/);
  });

  it("native argv never carries an approval-bypass flag", () => {
    expect(NATIVE_ARGV).toEqual({ codex: ["exec", "-"], claude: ["-p"], pi: ["-p"] });
    expect(herdrAgentName(ITEM)).toBe("skep-i-7-e1");
  });

  it("the summary tail strips controls, redacts, and is capped", () => {
    const raw = `${"x".repeat(9_000)}\n${ESC}[1mtoken ${PLANTED}${ESC}[0m\r\n`;
    const tail = summaryTail(raw, fakeStrip);
    expect(tail.length).toBeLessThanOrEqual(4_000);
    expect(tail).not.toContain(ESC);
    expect(tail).not.toContain(PLANTED);
    expect(tail).toContain("[REDACTED:");
  });
});

describe("workItem with a live agent", () => {
  it.each(["done", "blocked", "unknown"] as const)(
    "reports starting, running and the final %s agent state",
    async (phase) => {
      const box = await sandbox();
      const c = capture(box.home, { env: box.env, cwd: box.repo });
      const onAgentState = vi.fn();
      const fake = fakeRuntime({ herdr: { wait: async () => phase } });
      const worker = itemWorker(box, c, "herdr", fake, { method: "none", onAgentState });
      await workItem(worker, ITEM);
      const final = phase === "unknown" ? "failed" : phase;
      expect(onAgentState.mock.calls).toEqual([
        [ITEM.itemId, "starting"],
        [ITEM.itemId, "running"],
        ...(phase === "blocked" ? [[ITEM.itemId, "blocked"]] : []),
        [ITEM.itemId, final],
      ]);
    },
  );

  it("reports a final failed state when no agent is configured, never a fake success", async () => {
    const dir = await home();
    const c = capture(dir, { cwd: dir, env: { PATH: defaultStubs } });
    const onAgentState = vi.fn();
    const result = await workItem(
      { ctx: c.ctx, dir, method: "none", ask: async () => null, onAgentState },
      ITEM,
    );
    expect(onAgentState).toHaveBeenLastCalledWith(ITEM.itemId, "failed");
    expect(result.checks).toEqual([{ name: "agent", status: "fail" }]);
    expect(result.summary).toContain("cause: no agent CLI is configured on this device");
  });

  it("pty: runs the CLI with the prompt as argv in the project folder, suspends the view", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime();
    const log = recordingView();
    const worker = itemWorker(box, c, "pty", fake, { view: log.view, method: "none" });
    const result = await workItem(worker, ITEM);
    expect(fake.ptyRuns).toHaveLength(1);
    const run = fake.ptyRuns[0];
    expect(run?.argv).toEqual(["claude", PROMPT]);
    expect(run?.input).toBe("inherit");
    expect(run?.cwd).toBe(box.repo);
    expect(run?.env.SKEP_SESSION_ITEM).toBe("I-7");
    expect(run?.env).not.toHaveProperty("SKEP_HOME");
    // The raw transcript stays in the local journal, 0600.
    expect(path.dirname(run?.transcriptPath ?? "")).toBe(path.join(box.home, "journal"));
    expect((await stat(run?.transcriptPath ?? "")).mode & 0o777).toBe(0o600);
    const suspend = log.events.indexOf("suspend");
    expect(log.events.slice(suspend, suspend + 2)).toEqual(["suspend", "resume"]);
    expect(log.events).toContain("update:running");
    expect(log.events.at(-1)).toBe("update:done");
    expect(result.submit).toMatchObject({ method: "none", state: "local", branch: "main" });
    expect(result.headSha).toBe(result.baseSha);
    expect(await readFile(path.join(box.repo, "feature.txt"), "utf8")).toBe("done\n");
    expect(result.summary).toContain("changed 1 file (+1 −0): feature.txt");
    expect(result.summary).toContain("agent exited 0");
    expect(result.summary).toContain("working\nfinished");
    expect(result.summary).not.toContain(ESC);
    expect(log.models.at(-1)?.tail).not.toContain(ESC);
  });

  it("pty: a planted secret in the transcript never reaches the summary", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      pty: async (run) => {
        await writeFile(path.join(run.cwd, "f.txt"), "x\n");
        const transcript = Buffer.from(
          `${"noise ".repeat(2_000)}\n${ESC}]0;title\u0007export GH=${PLANTED}\r\n`,
        );
        return { exit: { code: 0, signal: null }, aborted: false, transcript };
      },
    });
    const log = recordingView();
    const result = await workItem(
      itemWorker(box, c, "pty", fake, { view: log.view, method: "none" }),
      ITEM,
    );
    expect(result.summary.length).toBeLessThanOrEqual(4_000);
    expect(result.summary).not.toContain(PLANTED);
    expect(result.summary).toContain("[REDACTED:");
    expect(result.summary).not.toContain(ESC);
    expect(result.summary).not.toContain("\u0007");
    for (const model of log.models) expect(model.tail).not.toContain(PLANTED);
  });

  it("pty: a non-zero exit fails the item and leaves its edits for undo", async () => {
    const box = await sandbox();
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
    const fake = fakeRuntime({
      pty: async (run) => {
        await writeFile(path.join(run.cwd, "half.txt"), "x\n");
        return { exit: { code: 3, signal: null }, aborted: false, transcript: Buffer.from("") };
      },
    });
    const result = await workItem(itemWorker(box, c, "pty", fake), ITEM);
    expect(result.submit).toMatchObject({ state: "failed" });
    expect(result.headSha).toBe(result.baseSha);
    expect(result.summary).toContain("cause: agent claude exited 3");
    expect(result.summary).toContain("changed 1 file (+1 −0): half.txt");
    const undone = await undoItem(c.ctx, "I-7");
    expect(undone.removed).toEqual(["half.txt"]);
  });

  it("pty: an unavailable PTY falls back to the native CLI and says why", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      pty: async () => {
        throw new FakePtyUnavailableError("script(1) not found");
      },
    });
    const result = await workItem(itemWorker(box, c, "pty", fake, { method: "none" }), ITEM);
    expect(c.stderr).toContain("pty is unavailable: script(1) not found");
    expect(result.summary).toContain("ran claude non-interactively");
    expect(result.submit).toMatchObject({ state: "local" });
    const home = box.env.HOME ?? "";
    expect(await readFile(path.join(home, "claude-args.txt"), "utf8")).toBe("-p\n");
    expect(await readFile(path.join(home, "claude-stdin.txt"), "utf8")).toBe(PROMPT);
  });

  it("a missing runtime module falls back to native", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime();
    fake.runtime = async () => {
      throw new AgentRuntimeUnavailableError("not in this build");
    };
    const result = await workItem(itemWorker(box, c, "herdr", fake, { method: "none" }), ITEM);
    expect(c.stderr).toContain("herdr is unavailable: not in this build");
    expect(result.submit).toMatchObject({ state: "local" });
  });

  it("native: runs `codex exec -` with the prompt on stdin", async () => {
    const box = await sandbox();
    await stubAgent(box, "codex", 'echo "native output"');
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "none" });
    if (worker.agent !== undefined) worker.agent.cli = "codex";
    const result = await workItem(worker, ITEM);
    expect(result.summary).toContain("agent exited 0\nnative output");
    const home = box.env.HOME ?? "";
    expect(await readFile(path.join(home, "codex-args.txt"), "utf8")).toBe("exec\n-\n");
    expect(await readFile(path.join(home, "codex-stdin.txt"), "utf8")).toBe(PROMPT);
  });

  it("native: the agent works from the intent's full text, not the 200-character title (S8)", async () => {
    const box = await sandbox();
    await stubAgent(box, "codex", 'echo "native output"');
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "none" });
    if (worker.agent !== undefined) worker.agent.cli = "codex";
    const text = `make the login page remember the last user. ${"Details follow. ".repeat(60)}END`;
    const item = { ...ITEM, title: text.slice(0, 200) };
    await workItem(worker, item, { intentText: text });
    const stdin = await readFile(path.join(box.env.HOME ?? "", "codex-stdin.txt"), "utf8");
    expect(stdin.startsWith(`${text}\n\n`)).toBe(true);
    expect(stdin).toContain("END");
  });

  it("itemTask keeps the title when the text is missing or belongs to another intent", () => {
    const item = { ...ITEM, title: "add a health check" };
    expect(itemTask(item, {})).toBe("add a health check");
    expect(itemTask(item, { intentText: "  " })).toBe("add a health check");
    expect(itemTask(item, { intentText: "something else entirely" })).toBe("add a health check");
    expect(itemTask(item, { intentText: "add a health check\n\nwith /healthz" })).toBe(
      "add a health check\n\nwith /healthz",
    );
  });

  it("native: a finished run hands the view its whole output, beyond the 4000-char tail (S3)", async () => {
    const box = await sandbox();
    await stubAgent(
      box,
      "codex",
      'i=1; while [ $i -le 5000 ]; do echo "output line $i"; i=$((i+1)); done',
    );
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const log = recordingView();
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "none", view: log.view });
    if (worker.agent !== undefined) worker.agent.cli = "codex";
    const result = await workItem(worker, ITEM);
    expect(result.summary.length).toBeLessThanOrEqual(4000);
    const last = log.models.at(-1);
    expect(last?.tail.length).toBeLessThanOrEqual(4000);
    expect(last?.transcript).toContain("output line 1\n");
    expect(last?.transcript).toContain("output line 5000");
    expect((last?.transcript ?? "").length).toBeGreaterThan(50_000);
  });

  it("herdr: start, prompt, wait, read 200 lines in the project folder; done submits", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          await writeFile(path.join(box.repo, "pane.txt"), "x\n");
          return "done";
        },
        read: async () => `pane ${ESC}[31mred${ESC}[0m ${PLANTED}`,
      },
    });
    const log = recordingView();
    const result = await workItem(itemWorker(box, c, "herdr", fake, { view: log.view }), ITEM);
    expect(fake.herdrCalls).toEqual([
      "probe",
      `start skep-i-7-e1 claude ${box.repo}`,
      `prompt ${JSON.stringify(PROMPT)}`,
      "wait",
      "read",
    ]);
    expect(result.submit).toMatchObject({ method: "push", state: "pushed", branch: "main" });
    expect(result.summary).toContain("pane red");
    expect(result.summary).not.toContain(PLANTED);
    const running = log.models.find((m) => m.agent?.state === "running");
    expect(running?.agent).toMatchObject({
      cli: "claude",
      view: "herdr",
      focusCommand: ["herdr", "agent", "focus", "skep-i-7-e1"],
    });
  });

  it("herdr: blocked is pending, sends no keys, commits and submits nothing, and notifies", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          await writeFile(path.join(box.repo, "pane.txt"), "x\n");
          return "blocked";
        },
      },
    });
    const log = recordingView("push");
    const worker = itemWorker(box, c, "herdr", fake, {
      view: log.view,
      chooseSubmit: log.view.chooseSubmit,
    });
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const result = await workItem(worker, ITEM);
    expect(result.submit).toEqual({ method: "push", state: "pending", branch: "main" });
    expect(result.headSha).toBe(base);
    expect(await remoteHas(box, "main")).toBe(base);
    // Only the calls of a normal run: no focus, no prompt after the first, nothing else.
    expect(fake.herdrCalls.map((call) => call.split(" ")[0])).toEqual([
      "probe",
      "start",
      "prompt",
      "wait",
      "read",
    ]);
    const waiting = "agent skep-i-7-e1 is waiting for you: herdr agent focus skep-i-7-e1";
    expect(c.stderr).toContain(waiting);
    expect(worker.notes).toEqual([expect.objectContaining({ message: waiting })]);
    expect(log.events).not.toContain("choose:I-7");
    expect(log.models.at(-1)?.agent?.state).toBe("blocked");
    expect(log.models.at(-1)?.submit.outcome?.state).toBe("pending");
  });

  it("herdr: a fallbackSafe error before the prompt falls back to native", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      herdr: {
        prompt: async () => {
          throw new FakeSessionError("herdr agent prompt failed: not ready", true);
        },
      },
    });
    const result = await workItem(itemWorker(box, c, "herdr", fake, { method: "none" }), ITEM);
    expect(c.stderr).toContain("herdr is unavailable: herdr agent prompt failed: not ready");
    // The pane it opened is closed before the native run.
    expect(fake.herdrCalls.at(-1)).toBe("close");
    expect(result.submit).toMatchObject({ state: "local" });
    expect(await stat(path.join(box.env.HOME ?? "", "claude-called"))).toBeTruthy();
  });

  it("herdr: an error after the prompt was accepted fails the item and never re-runs", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          throw new FakeSessionError("herdr agent wait: timeout", false);
        },
      },
    });
    const result = await workItem(itemWorker(box, c, "herdr", fake), ITEM);
    expect(result.submit).toMatchObject({ method: "push", state: "failed" });
    expect(result.summary).toContain("herdr agent wait: timeout");
    await expect(stat(path.join(box.env.HOME ?? "", "claude-called"))).rejects.toThrow();
    expect(c.stderr).not.toContain("non-interactively");
  });

  it("ask with a view: chooseSubmit replaces the stdin question", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const log = recordingView("push");
    const result = await workItem(
      itemWorker(box, c, "pty", fakeRuntime(), {
        view: log.view,
        chooseSubmit: log.view.chooseSubmit,
        method: "ask",
        ask: async () => {
          throw new Error("ask must not be used");
        },
      }),
      ITEM,
    );
    expect(log.events).toContain("choose:I-7");
    expect(result.submit).toMatchObject({ method: "push", state: "pushed" });
    expect(c.stderr).not.toContain("Submit this item?");
  });
});

/** `skep session join` against a real master with extra context (fake runtime, notify). */
async function joinWith(
  box: Sandbox,
  extraArgs: string[],
  extra: Partial<SessionCliContext> = {},
): Promise<{ item: ItemStatus; run: ReturnType<typeof capture>; exit: number }> {
  const { item, run, exit } = await joinAndWork(box, extraArgs, extra, false);
  return { item, run, exit };
}

describe("session join with a live agent", () => {
  afterEach(() => setJoinViewFactory(null));

  it("SKEP_SESSION_VIEW=pty selects pty with the CLI from an AGENT.md that happens to exist", async () => {
    const box = await sandbox();
    box.env = { ...box.env, SKEP_SESSION_VIEW: "pty" };
    await stubAgent(box, "pi");
    await writeFile(path.join(box.repo, "AGENT.md"), AGENT_MD("pi"));
    const fake = fakeRuntime();
    const { item, exit, run } = await joinWith(box, ["--submit", "none"], {
      agentRuntime: fake.runtime,
    });
    expect(exit).toBe(0);
    expect(fake.ptyRuns.map((r) => r.argv)).toEqual([["pi", PROMPT]]);
    expect(item.result?.submit).toMatchObject({ state: "local" });
    expect(run.stderr).toContain("item I-1: agent pi (pty) running");
    expect(run.stderr).toContain("item I-1: agent pi (pty) done");
  });

  it("SKEP_SESSION_VIEW=herdr selects herdr and prints the focus command", async () => {
    const box = await sandbox();
    box.env = { ...box.env, SKEP_SESSION_VIEW: "herdr" };
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          await writeFile(path.join(box.repo, "h"), "");
          return "idle";
        },
      },
    });
    const { item, run } = await joinWith(box, ["--submit", "none"], {
      agentRuntime: fake.runtime,
    });
    expect(fake.ptyRuns).toHaveLength(0);
    expect(fake.herdrCalls[1]).toBe(`start skep-i-1-e1 claude ${box.repo}`);
    expect(run.stderr).toContain("watch with: herdr agent focus skep-i-1-e1");
    expect(item.result?.submit).toMatchObject({ state: "local" });
  });

  it("--view herdr blocked: pending result, message printed, notification sent", async () => {
    const box = await sandbox();
    const notes: Notification[] = [];
    const fake = fakeRuntime({ herdr: { wait: async () => "blocked" } });
    const { item, run } = await joinWith(box, ["--submit", "push", "--view", "herdr"], {
      agentRuntime: fake.runtime,
      notify: async (n) => notes.push(n),
    });
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pending" });
    expect(run.stderr).toContain(
      "agent skep-i-1-e1 is waiting for you: herdr agent focus skep-i-1-e1",
    );
    expect(notes).toHaveLength(1);
  });

  it("--ui without a registered view exits with a clear message", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const exit = await runCli(
      ["session", "join", "--code", "123456789012", "--host", "127.0.0.1:1", "--ui"],
      c.ctx,
    );
    expect(exit).toBe(1);
    expect(c.stderr).toContain("the full-screen view is not available in this build");
  });

  it("--ui uses the registered factory: updates, suspend/resume around pty, chooseSubmit", async () => {
    const box = await sandbox();
    const log = recordingView("push");
    let made = 0;
    setJoinViewFactory(() => {
      made += 1;
      return log.view;
    });
    const fake = fakeRuntime();
    const { item, run, exit } = await joinWith(
      box,
      ["--ui", "--submit", "ask", "--agent", "claude", "--view", "pty"],
      { agentRuntime: fake.runtime, stdin: new PassThrough() },
    );
    expect(exit).toBe(0);
    expect(made).toBe(1);
    expect(log.events).toContain("suspend");
    expect(log.events.indexOf("resume")).toBe(log.events.indexOf("suspend") + 1);
    expect(log.events).toContain("choose:I-1");
    expect(log.events.at(-1)).toBe("close");
    expect(log.models[0]?.peers).toEqual([
      {
        peerId: expect.any(String),
        device: "vps",
        repo: "app",
        role: "coding",
        state: "idle",
        progress: {
          phase: "idle",
          done: 0,
          total: 0,
          failed: 0,
          percent: 0,
          summary: "",
        },
      },
    ]);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pushed" });
    // The full-screen view owns the terminal: no line output and no stdin question.
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("Submit this item?");
  });
});

describe("SESSION-UX fix round (R2-R5)", () => {
  const instantClock = { monotonicMs: () => 0, nowMs: () => 1_000, sleep: async () => {} };

  function ctxFor(box: Sandbox) {
    return capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
  }

  async function submitCli(box: Sandbox, itemId: string, method: string) {
    const c = ctxFor(box);
    const exit = await runCli(["session", "submit", itemId, "--method", method], c.ctx);
    return { exit, c };
  }

  const I1 = { ...ITEM, itemId: "I-1" };

  it.each(["no changes", "declined", "skipped before start", "failed before running"] as const)(
    "R2: a later session's I-1 (%s) can neither undo nor submit the earlier session's files",
    async (second) => {
      const box = await sandbox();
      const c = ctxFor(box);
      const first = itemWorker(box, c, "native", fakeRuntime(), {
        method: "none",
        sessionId: () => "session-a",
      });
      await workItem(first, I1);
      expect(await readFile(path.join(box.repo, "health.txt"), "utf8")).toBe("ok\n");

      await stubAgent(box, "claude", 'echo "nothing to do"');
      const abort = new AbortController();
      if (second === "skipped before start") abort.abort();
      const later = itemWorker(box, c, "native", fakeRuntime(), {
        method: "none",
        sessionId: () => "session-b",
        signal: abort.signal,
        ...(second === "declined" ? { confirmItems: true, ask: async () => "n" } : {}),
      });
      if (second === "failed before running") delete later.agent;
      const result = await workItem(later, I1);
      if (second === "no changes") expect(result.summary).toContain("no changes");

      await expect(undoItem(c.ctx, "I-1")).rejects.toThrow(
        /latest run of I-1 \(session session-b\) changed no files/,
      );
      const { exit, c: out } = await submitCli(box, "I-1", "commit");
      expect(exit).not.toBe(0);
      expect(out.stderr).toContain("latest run of I-1 (session session-b) changed no files");
      // Session A's work is untouched and uncommitted.
      expect(await readFile(path.join(box.repo, "health.txt"), "utf8")).toBe("ok\n");
      expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe(
        "M notes.txt\n?? health.txt",
      );
    },
  );

  it.each(["commit", "push", "pr"] as const)(
    "R3: deferred submit %s refuses a file edited by hand after the item",
    async (method) => {
      const box = await sandbox();
      await writeFile(path.join(box.bin, "gh"), "#!/bin/sh\necho https://github.com/o/r/pull/1\n", {
        mode: 0o755,
      });
      const c = ctxFor(box);
      await workItem(itemWorker(box, c, "native", fakeRuntime(), { method: "none" }), I1);
      await writeFile(path.join(box.repo, "notes.txt"), "later human edit\n");
      const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
      const { exit, c: out } = await submitCli(box, "I-1", method);
      expect(exit).not.toBe(0);
      expect(out.stderr).toContain("notes.txt changed after I-1");
      expect(out.stderr).toContain("nothing was staged, committed or pushed");
      expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
      expect(await gitIn(box.repo, ["diff", "--cached", "--name-only"], box.env)).toBe("");
      expect(await gitIn(box.repo, ["branch", "--list", "skep/*"], box.env)).toBe("");
      expect(await remoteHas(box, "main")).toBe(base);
      expect(await readFile(path.join(box.repo, "notes.txt"), "utf8")).toBe("later human edit\n");
    },
  );

  it("R3: an earlier item is not submitted with a later item's edit of the same file", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    await workItem(itemWorker(box, c, "native", fakeRuntime(), { method: "none" }), I1);
    await stubAgent(box, "claude", 'printf "second item\\n" > notes.txt');
    await workItem(itemWorker(box, c, "native", fakeRuntime(), { method: "none" }), {
      ...ITEM,
      itemId: "I-2",
    });
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const refused = await submitCli(box, "I-1", "push");
    expect(refused.exit).not.toBe(0);
    expect(refused.c.stderr).toContain("notes.txt changed after I-1");
    expect(await remoteHas(box, "main")).toBe(base);
    // The later item is what the folder holds now: it submits.
    const ok = await submitCli(box, "I-2", "push");
    expect(ok.exit).toBe(0);
    expect(await gitIn(box.repo, ["show", "HEAD:notes.txt"], box.env)).toBe("second item");
  });

  it("R4: a blocked agent keeps the queue until it resumes; the next item never sees its edits", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    const answered = deferred();
    const order: string[] = [];
    let waits = 0;
    const fake = fakeRuntime({
      herdr: {
        start: async (start: { name: string }) => {
          order.push(`start ${start.name}`);
          return {
            name: start.name,
            paneId: "p",
            focusCommand: ["herdr", "agent", "focus", start.name],
          };
        },
        wait: async (handle: { name: string }) => {
          if (handle.name === "skep-i-2-e1") {
            await writeFile(path.join(box.repo, "second.txt"), "2\n");
            return "done";
          }
          waits += 1;
          if (waits === 1) return "blocked";
          // The human answers in the pane; the agent goes on editing, then finishes.
          await answered.promise;
          await writeFile(path.join(box.repo, "resumed.txt"), "after the answer\n");
          order.push("I-1 resumed and wrote");
          return "done";
        },
      },
    });
    const serial = serialQueue();
    const worker = itemWorker(box, c, "herdr", fake, {
      method: "none",
      serial,
      clock: instantClock,
    });
    const first = workItem(worker, I1);
    const second = workItem(worker, { ...ITEM, itemId: "I-2" });
    const pending = await first;
    expect(pending.submit?.state).toBe("pending");
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["start skep-i-1-e1"]);
    answered.resolve();
    const next = await second;
    expect(order).toEqual(["start skep-i-1-e1", "I-1 resumed and wrote", "start skep-i-2-e1"]);
    expect(next.summary).toContain("changed 1 file (+1 −0): second.txt");
    expect(next.summary).not.toContain("resumed.txt");
    // The blocked run's record covers what it wrote after the answer, so undo reverts it.
    expect(c.stderr).toContain("item I-1: the agent done; changed 1 file (+1 −0): resumed.txt");
    await undoItem(c.ctx, "I-1");
    await expect(stat(path.join(box.repo, "resumed.txt"))).rejects.toThrow();
    expect(await readFile(path.join(box.repo, "second.txt"), "utf8")).toBe("2\n");
  });

  it("R5: an agent that committed its own change still gets the requested push", async () => {
    const box = await sandbox();
    await stubAgent(
      box,
      "claude",
      'printf "agent\\n" > notes.txt\n' +
        "git -c user.name=a -c user.email=a@example.invalid commit -qam agent-commit",
    );
    const c = ctxFor(box);
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const result = await workItem(
      itemWorker(box, c, "native", fakeRuntime(), { method: "push" }),
      I1,
    );
    const head = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    expect(head).not.toBe(base);
    expect(result.summary).toContain("changed 1 file (+1 −2): notes.txt");
    expect(result.submit).toEqual({ method: "push", state: "pushed", branch: "main" });
    expect(await remoteHas(box, "main")).toBe(head);
  });

  it("R5: none, then submit commit, then submit push publishes the commit", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    await workItem(itemWorker(box, c, "native", fakeRuntime(), { method: "none" }), I1);
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    expect((await submitCli(box, "I-1", "commit")).exit).toBe(0);
    const committed = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    expect(committed).not.toBe(base);
    const push = await submitCli(box, "I-1", "push");
    expect(push.exit).toBe(0);
    expect(push.c.stdout).toContain("submit push pushed");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(committed);
    expect(await remoteHas(box, "main")).toBe(committed);
    // A second commit has nothing left and says so honestly.
    const again = await submitCli(box, "I-1", "commit");
    expect(again.exit).toBe(0);
    expect(again.c.stdout).toContain(`submit commit local ${committed.slice(0, 7)} on main`);
    expect(again.c.stdout).toContain("already committed");
  });

  it("R6: a failed push is a FAILED result with cause and fix, not done", async () => {
    const box = await sandbox();
    await rm(box.bare, { recursive: true, force: true });
    const c = ctxFor(box);
    const result = await workItem(
      itemWorker(box, c, "native", fakeRuntime(), { method: "push" }),
      I1,
    );
    expect(result.submit).toMatchObject({ method: "push", state: "failed" });
    const lines = result.summary.split("\n");
    expect(lines[0]).toBe("submit push failed");
    expect(lines[1]).toMatch(/^FAILED · claude · /);
    expect(result.summary).toContain("cause: submit push failed: ");
    expect(result.summary).toContain("fix: the edits stay in");
    expect(result.summary).toContain("skep session submit I-1 --epoch 1 --method push");
  });
});

describe("SESSION-UX fix round 2 (R10-R11)", () => {
  // Yields to timers between polls, so a watch that keeps retrying never starves the test.
  const yieldingClock = {
    monotonicMs: () => 0,
    nowMs: () => 1_000,
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) return reject(new Error("aborted"));
        setTimeout(resolve, 1);
      }),
  };
  const I1 = { ...ITEM, itemId: "I-1" };
  const tick = () => new Promise((r) => setTimeout(r, 50));

  function ctxFor(box: Sandbox) {
    return capture(box.home, {
      env: box.env,
      cwd: box.repo,
      paths: skepPaths(box.env.SKEP_HOME ?? ""),
    });
  }

  /** I-1 blocks, then every later wait on it fails as a timeout; I-2 finishes at once. */
  function timingOut(box: Sandbox, order: string[], close: () => Promise<void>) {
    let waits = 0;
    return fakeRuntime({
      herdr: {
        start: async (start: { name: string }) => {
          order.push(`start ${start.name}`);
          return {
            name: start.name,
            paneId: "p",
            focusCommand: ["herdr", "agent", "focus", start.name],
          };
        },
        wait: async (handle: { name: string }) => {
          if (handle.name === "skep-i-2-e1") return "done";
          waits += 1;
          if (waits === 1) return "blocked";
          // The agent is still live and editing while the watch loses track of it.
          await writeFile(path.join(box.repo, "late.txt"), `write ${waits}\n`);
          throw new Error("herdr agent wait timed out");
        },
        close: async (handle: { name: string }) => {
          order.push(`close ${handle.name}`);
          await close();
        },
      },
    });
  }

  it("R10: a wait timeout holds the queue until skep has closed the agent's pane", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    const order: string[] = [];
    const closing = deferred();
    const fake = timingOut(box, order, () => closing.promise);
    const worker = itemWorker(box, c, "herdr", fake, {
      method: "none",
      serial: serialQueue(),
      clock: yieldingClock,
    });
    const first = workItem(worker, I1);
    const second = workItem(worker, { ...ITEM, itemId: "I-2" });
    expect((await first).submit?.state).toBe("pending");
    await tick();
    // The wait failed and a close is in flight, but nothing confirmed the agent stopped.
    expect(order).toEqual(["start skep-i-1-e1", "close skep-i-1-e1"]);
    closing.resolve();
    await second;
    expect(order).toEqual(["start skep-i-1-e1", "close skep-i-1-e1", "start skep-i-2-e1"]);
    expect(c.stderr).toContain(
      "item I-1: the agent lost (herdr agent wait timed out); skep closed its pane; " +
        "changed 1 file (+1 −0): late.txt",
    );
  });

  it("R10: when the pane cannot be closed, no later item starts until the join closes", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    const order: string[] = [];
    const fake = timingOut(box, order, async () => {
      throw new Error("herdr is gone");
    });
    const abort = new AbortController();
    const worker = itemWorker(box, c, "herdr", fake, {
      method: "none",
      serial: serialQueue(),
      clock: yieldingClock,
      signal: abort.signal,
    });
    const first = workItem(worker, I1);
    const second = workItem(worker, { ...ITEM, itemId: "I-2" });
    expect((await first).submit?.state).toBe("pending");
    await tick();
    const closes = order.filter((entry) => entry === "close skep-i-1-e1").length;
    expect(closes).toBeGreaterThan(1);
    expect(order).not.toContain("start skep-i-2-e1");
    // Closing the join cancels the watch; the queued item then never runs beside the agent.
    abort.abort();
    await second;
    expect(order).not.toContain("start skep-i-2-e1");
    expect(c.stderr).not.toContain("item I-1: the agent");
  });

  it("R11: a blocked agent that reverts its interim edit leaves an empty record", async () => {
    const box = await sandbox();
    const c = ctxFor(box);
    let waits = 0;
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          waits += 1;
          if (waits === 1) {
            await writeFile(path.join(box.repo, "notes.txt"), "interim\n");
            return "blocked";
          }
          await writeFile(path.join(box.repo, "notes.txt"), "one\ntwo\n");
          return "done";
        },
      },
    });
    const serial = serialQueue();
    const worker = itemWorker(box, c, "herdr", fake, {
      method: "none",
      serial,
      clock: yieldingClock,
    });
    const pending = await workItem(worker, I1);
    expect(pending.summary).toContain("notes.txt");
    await serial(async () => undefined);
    expect(c.stderr).toContain("item I-1: the agent done; no changes");
    const recorded = await readDeltaRecord(box.env.SKEP_HOME ?? "", "I-1");
    expect(recorded?.files).toEqual([]);

    const head = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    await expect(undoItem(c.ctx, "I-1")).rejects.toThrow(/latest run of I-1 .*changed no files/);
    const out = ctxFor(box);
    const exit = await runCli(["session", "submit", "I-1", "--method", "commit"], out.ctx);
    expect(exit).not.toBe(0);
    expect(out.stderr).toMatch(/latest run of I-1 .*changed no files/);
    expect(await readFile(path.join(box.repo, "notes.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await gitIn(box.repo, ["status", "--porcelain"], box.env)).toBe("");
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(head);
  });
});

describe("session start skill selection (SKILL-MVP)", () => {
  it("accepts --skill without changing session wire options and publishes the local selection", async () => {
    const dir = await home();
    const fake = fakeApi();
    const io = capture(dir, { sessionApi: fake.api, cwd: dir });
    const running = runCli(
      ["session", "start", "--yes", "--repo", "app", "--skill", "iot-ble-feature"],
      io.ctx,
    );
    try {
      await vi.waitFor(() => expect(fake.calls.master).toHaveLength(1));
      await vi.waitFor(() => expect(io.stdout).toContain("skill: iot-ble-feature"));
      expect(fake.calls.master[0]).not.toHaveProperty("skill");
      expect(JSON.parse(await readFile(path.join(dir, "session.json"), "utf8")).skill).toBe(
        "iot-ble-feature",
      );
    } finally {
      fake.closed.resolve();
    }
    expect(await running).toBe(0);
  });
  it("refuses an unknown skill before opening a listener", async () => {
    const dir = await home();
    const fake = fakeApi();
    const io = capture(dir, { sessionApi: fake.api, cwd: dir });
    expect(
      await runCli(
        ["session", "start", "--yes", "--repo", "app", "--skill", "missing-skill"],
        io.ctx,
      ),
    ).not.toBe(0);
    expect(fake.calls.master).toHaveLength(0);
    expect(io.stderr).toContain("unknown skill missing-skill");
  });
});
