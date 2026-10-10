import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "../../notify/ntfy.js";
import { startMaster } from "../../session/index.js";
import type { ItemStatus } from "../../session/messages.js";
import { runCli } from "../program.js";
import {
  type AgentRuntime,
  AgentRuntimeUnavailableError,
  type AgentSessionBackend,
  type AgentView,
  encodeFrame,
  expandStartWithMaster,
  FrameDecoder,
  formatJoinCli,
  herdrAgentName,
  type ItemWorker,
  type JoinView,
  type JoinViewModel,
  loadSubmitPolicy,
  type MasterHandle,
  type MasterOptions,
  materializeItem,
  NATIVE_ARGV,
  type PeerProgress,
  type PtyRunOptions,
  type PtyRunResult,
  parseHostPort,
  pickListenHost,
  renderSessionStatus,
  type SessionApi,
  type SessionCliContext,
  type SessionStatus,
  SessionStatusSchema,
  type SubHandle,
  type SubOptions,
  selectAgentView,
  sessionBranch,
  setJoinViewFactory,
  summaryTail,
  workItem,
} from "./session.js";

const roots: string[] = [];
const servers: net.Server[] = [];
const TOKEN = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
    env: { SKEP_HOME: dir },
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

/** A master that answers one control request per connection with `reply`. */
async function mockMaster(reply: unknown): Promise<{ listen: string; requests: unknown[] }> {
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
    expect(c.stdout).toContain(
      "paste into skep: /join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app",
    );
    expect(c.stdout).toContain(
      "or from a shell: skep session join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app",
    );
    fake.calls.master[0]?.onJoinCode({ code: "999988887777", expiresAtMs: 1_800_000_600_000 });
    expect(c.stdout).toContain("/join --host 203.0.113.7:7419 --code 9999-8888-7777 --repo app");
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
  ])("--advertise %j never reaches startMaster", async (advertise) => {
    const fake = fakeApi("10.1.2.3:7500");
    const c = capture(await home(), { sessionApi: fake.api });
    const argv = ["--machine", "session", "start", "--yes", "--repo", "app"];
    expect(await runCli([...argv, `--advertise=${advertise}`], c.ctx)).toBe(2);
    expect(JSON.parse(c.stdout).error.message).toMatch(/^--advertise must/);
    expect(fake.calls.master).toHaveLength(0);
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
    const repo = "it's my app; false $(x) `y` | z";
    const twin = formatJoinCli({ host: "[fe80::1]:7419", code: "863217270308", repo });
    expect(twin.startsWith("skep session join ")).toBe(true);
    // The twin is meant for a shell, so a real POSIX shell is the oracle here.
    const args = twin.slice("skep session join ".length);
    const { stdout } = await execFileP("sh", ["-c", `set -- ${args}; printf '%s\\0' "$@"`]);
    expect(stdout.split("\0").slice(0, -1)).toEqual([
      "--host",
      "[fe80::1]:7419",
      "--code",
      "8632-1727-0308",
      "--repo",
      repo,
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

  it("refuses to start when the recorded master still answers", async () => {
    const dir = await home();
    const mock = await mockMaster({ type: "control-result", ok: true, result: STATUS });
    await writeSessionFile(dir, mock.listen);
    const fake = fakeApi();
    const c = capture(dir, { sessionApi: fake.api });
    expect(await runCli(["--machine", "session", "start", "--repo", "app"], c.ctx)).toBe(1);
    expect(JSON.parse(c.stdout).error.code).toBe("session_running");
    expect(fake.calls.master).toHaveLength(0);
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
    expect(mock.requests).toEqual([{ type: "control", v: 1, token: TOKEN, op: "status" }]);
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
// Sub-side item work against a real in-memory master and throwaway git repos. No agent CLI, no
// network: `origin` is a local bare repo and `gh`/`glab` are never on PATH.

const execFileP = promisify(execFile);
const HOST = "127.0.0.1";

interface Sandbox {
  home: string;
  repo: string;
  bare: string;
  env: NodeJS.ProcessEnv;
}

async function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return (await execFileP("git", args, { cwd, env: env as Record<string, string> })).stdout.trim();
}

/** A repo named `app` with one commit and a bare `origin`; HOME points into the temp dir. */
async function sandbox(): Promise<Sandbox> {
  const root = await home();
  const repo = path.join(root, "app");
  const bare = path.join(root, "origin.git");
  const fakeHome = path.join(root, "userhome");
  await mkdir(repo);
  await mkdir(fakeHome);
  // A PATH without gh/glab: only git's own directory, so host commands are "not installed".
  const gitPath = (await execFileP("sh", ["-c", "command -v git"])).stdout.trim();
  const env = {
    PATH: path.dirname(gitPath),
    HOME: fakeHome,
    SKEP_HOME: path.join(root, "skep"),
  };
  await gitIn(root, ["init", "--quiet", "--bare", bare], env);
  await gitIn(repo, ["init", "--quiet", "-b", "main"], env);
  await writeFile(path.join(repo, "README.md"), "app\n");
  await gitIn(repo, ["add", "README.md"], env);
  const who = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  await gitIn(repo, [...who, "commit", "--quiet", "-m", "init"], env);
  await gitIn(repo, ["remote", "add", "origin", bare], env);
  await gitIn(repo, ["push", "--quiet", "origin", "main"], env);
  return { home: root, repo, bare, env };
}

async function remoteHas(box: Sandbox, branch: string): Promise<string | null> {
  return gitIn(
    box.repo,
    ["--git-dir", box.bare, "rev-parse", "--verify", `refs/heads/${branch}`],
    box.env,
  ).catch(() => null);
}

/** Runs `skep session join` against a real master, sends one intent, returns the item status. */
async function joinAndWork(
  box: Sandbox,
  extraArgs: string[],
  stdin?: PassThrough,
): Promise<{ item: ItemStatus; run: ReturnType<typeof capture>; exit: number }> {
  const master = await startMaster({
    listen: { host: HOST, port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
  });
  try {
    const code = master.status().joinCode;
    if (code === null || master.address === null) throw new Error("master has no join code");
    const c = capture(box.home, {
      env: box.env,
      cwd: box.repo,
      ...(stdin === undefined ? {} : { stdin }),
    });
    const argv = [
      "--machine",
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
    const item = master.status().intents[0]?.items[0];
    if (item === undefined) throw new Error("no item");
    await master.close();
    return { item, run: c, exit: await exit };
  } finally {
    await master.close();
  }
}

describe("session join works items", () => {
  it("--submit none commits on the session branch and reports local without pushing", async () => {
    const box = await sandbox();
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item, exit, run } = await joinAndWork(box, ["--submit", "none"]);
    expect(exit).toBe(0);
    const branch = "skep/session/I-1-e1";
    const head = await gitIn(box.repo, ["rev-parse", branch], box.env);
    expect(item.result).toMatchObject({
      repo: "app",
      baseSha: base,
      headSha: head,
      checks: [{ name: "none", status: "skip" }],
      submit: { method: "none", state: "local", branch },
    });
    expect(head).not.toBe(base);
    expect(item.result?.summary.split("\n")[0]).toBe("submit none local");
    expect(await gitIn(box.repo, ["log", "-1", "--format=%s", branch], box.env)).toBe(
      "session I-1 epoch 1",
    );
    expect(await gitIn(box.repo, ["show", `${branch}:.skep-session-item`], box.env)).toBe("I-1");
    // The device's own checkout is untouched and nothing reached origin.
    expect(await gitIn(box.repo, ["rev-parse", "HEAD"], box.env)).toBe(base);
    expect(await remoteHas(box, branch)).toBeNull();
    expect(run.stdout).toContain('"event":"item-result"');

    // `skep session submit --method none` on that branch prints local and still does not push.
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    expect(await runCli(["session", "submit", "I-1", "--method", "none"], c.ctx)).toBe(0);
    expect(c.stdout).toBe("submit none local\n");
    expect(await remoteHas(box, branch)).toBeNull();
  });

  it("--submit push pushes only the session branch to origin", async () => {
    const box = await sandbox();
    const mainBefore = await remoteHas(box, "main");
    const { item, exit } = await joinAndWork(box, ["--submit", "push"]);
    expect(exit).toBe(0);
    const branch = "skep/session/I-1-e1";
    expect(item.result?.submit).toEqual({ method: "push", state: "pushed", branch });
    expect(await remoteHas(box, branch)).toBe(item.result?.headSha);
    expect(await remoteHas(box, "main")).toBe(mainBefore);
  });

  it("uses the device.toml policy when --submit is absent", async () => {
    const box = await sandbox();
    await mkdir(path.join(box.home, "skep"), { recursive: true });
    await writeFile(
      path.join(box.home, "skep", "device.toml"),
      '[submit]\nmethod = "pr"\nhost = "git"\n',
    );
    const { item } = await joinAndWork(box, []);
    // host = "git" forces push.
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pushed" });
  });

  it("joins in auto mode by default: no per-item question before the run", async () => {
    const box = await sandbox();
    const { item, run } = await joinAndWork(box, ["--submit", "none"]);
    expect(run.stderr).not.toContain("Run item");
    expect(run.stdout).toContain('"control":"auto"');
    expect(item.result?.submit).toMatchObject({ method: "none", state: "local" });
  });

  it("--manual asks before each item; Enter runs it", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("\n");
    const { item, run } = await joinAndWork(box, ["--manual", "--submit", "none"], stdin);
    expect(run.stdout).toContain('"control":"manual"');
    expect(run.stderr).toContain("Run item I-1 (app): add a health check? [Y/n]");
    expect(item.result?.submit).toMatchObject({ method: "none", state: "local" });
  });

  it("--manual: n declines the item without checking anything out", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("n\n");
    const { item } = await joinAndWork(box, ["--manual", "--submit", "push"], stdin);
    const branch = "skep/session/I-1-e1";
    expect(item.result?.checks).toEqual([{ name: "peer", status: "skip" }]);
    expect(item.result?.submit).toEqual({ method: "push", state: "skipped", branch });
    expect(item.result?.summary).toContain("declined on this device (manual mode)");
    await expect(gitIn(box.repo, ["rev-parse", "--verify", branch], box.env)).rejects.toThrow();
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

  it("ask: prints branch and sha, then a typed answer submits", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.write("push\n");
    const { item, run } = await joinAndWork(box, ["--submit", "ask"], stdin);
    expect(run.stderr).toContain("Submit this item? [pr/mr/push/none/skip]");
    expect(run.stderr).toContain(`skep/session/I-1-e1 at ${item.result?.headSha}`);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pushed" });
  });

  it("ask: skip or EOF leaves the branch local as skipped, and submit can push it later", async () => {
    const box = await sandbox();
    const stdin = new PassThrough();
    stdin.end();
    const { item } = await joinAndWork(box, [], stdin);
    const branch = "skep/session/I-1-e1";
    expect(item.result?.submit).toEqual({ method: "ask", state: "skipped", branch });
    expect(await remoteHas(box, branch)).toBeNull();

    const c = capture(box.home, { env: box.env, cwd: box.repo });
    expect(await runCli(["--machine", "session", "submit", "I-1", "--method", "push"], c.ctx)).toBe(
      0,
    );
    expect(JSON.parse(c.stdout).result.submit).toEqual({ method: "push", state: "pushed", branch });
    expect(await remoteHas(box, branch)).toBe(item.result?.headSha);
  });

  it("pr without gh on PATH stays local and does not push", async () => {
    const box = await sandbox();
    const { item } = await joinAndWork(box, ["--submit", "pr"]);
    expect(item.result?.submit).toMatchObject({ method: "pr", state: "local" });
    expect(await remoteHas(box, "skep/session/I-1-e1")).toBeNull();
  });

  it("a failing check is reported and not submitted", async () => {
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
    const { item } = await joinAndWork(box, ["--submit", "push"]);
    expect(item.result?.checks).toEqual([{ name: "unit", status: "fail" }]);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "skipped" });
    expect(await remoteHas(box, "skep/session/I-1-e1")).toBeNull();
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

  it("a push that fails is a failed outcome, not a crash", async () => {
    const box = await sandbox();
    await rm(box.bare, { recursive: true, force: true });
    const { item, exit } = await joinAndWork(box, ["--submit", "push"]);
    expect(exit).toBe(0);
    expect(item.result?.submit).toMatchObject({ method: "push", state: "failed" });
  });

  it("a git failure while materializing is reported as failed", async () => {
    const box = await sandbox();
    // The branch already exists from an earlier session: never clobbered.
    await gitIn(box.repo, ["branch", "skep/session/I-1-e1"], box.env);
    const base = await gitIn(box.repo, ["rev-parse", "HEAD"], box.env);
    const { item, exit } = await joinAndWork(box, ["--submit", "push"]);
    expect(exit).toBe(0);
    expect(item.result).toMatchObject({
      baseSha: base,
      headSha: base,
      checks: [{ name: "git", status: "fail" }],
      submit: { method: "push", state: "failed" },
    });
    expect(item.result?.summary).toContain("already exists");
  });
});

describe("session submit policy and materialize fallback", () => {
  it("defaults to ask; reads method; host git forces push; a bad file falls back", async () => {
    const dir = await home();
    const file = path.join(dir, "device.toml");
    expect(await loadSubmitPolicy(file)).toEqual({ method: "ask", host: "github" });
    await writeFile(file, 'schema = "skep.device/v1"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "ask", host: "github" });
    await writeFile(file, '[submit]\nmethod = "mr"\nhost = "gitlab"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "mr", host: "gitlab" });
    await writeFile(file, '[submit]\nhost = "git"\n');
    expect(await loadSubmitPolicy(file)).toEqual({ method: "push", host: "git" });
    const warnings: string[] = [];
    await writeFile(file, '[submit]\nmethod = "fax"\n');
    expect(await loadSubmitPolicy(file, (w) => warnings.push(w))).toEqual({
      method: "ask",
      host: "github",
    });
    expect(warnings).toHaveLength(1);
  });

  it("falls back to a local clone and fetches the branch back", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const item = {
      itemId: "I-4",
      repo: "app",
      assignee: "P-1",
      epoch: 2,
      title: "x",
      datalistEntries: 0,
    };
    const root = path.join(box.home, "work");
    const work = await materializeItem(c.ctx, item, root, { worktree: false });
    expect(work.clone).not.toBeNull();
    expect(work.branch).toBe("skep/session/I-4-e2");
    expect(await gitIn(work.dir, ["remote", "get-url", "origin"], box.env)).toBe(box.bare);
    const result = await workItem(
      {
        ctx: c.ctx,
        root: path.join(box.home, "other"),
        method: "none",
        ask: async () => null,
        worktree: false,
      },
      { ...item, itemId: "I-5" },
    );
    expect(result.submit).toMatchObject({ state: "local" });
    expect(sessionBranch("I-5", 2)).toBe("skep/session/I-5-e2");
    // A clone, not a linked worktree: the device repo only has its own checkout registered.
    expect(await gitIn(box.repo, ["worktree", "list", "--porcelain"], box.env)).not.toContain(
      "I-5",
    );
    expect(await gitIn(box.repo, ["rev-parse", "skep/session/I-5-e2"], box.env)).toBe(
      result.headSha,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// SK-621: live agent view. Fake PtyRunner and AgentSessionBackend; the native fallback runs a
// fake CLI script from a temp PATH entry. No real agent CLI, PTY or herdr.

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

/**
 * A fake agent CLI on PATH for the native path: records argv and stdin into the worktree (so they
 * are committed) and touches `$HOME/native-called`.
 */
async function fakeCli(box: Sandbox, name: string): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(box.home, "bin");
  await mkdir(bin, { recursive: true });
  const script = path.join(bin, name);
  await writeFile(
    script,
    '#!/bin/sh\nprintf "%s\\n" "$@" > native-args.txt\ncat > native-stdin.txt\n' +
      ': > "$HOME/native-called"\necho "native output"\n',
    { mode: 0o755 },
  );
  return { ...box.env, PATH: `${bin}${path.delimiter}${box.env.PATH}` };
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

function recordingView(choice: "pr" | "mr" | "push" | "none" | null = null): ViewLog {
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

function itemWorker(
  box: Sandbox,
  c: ReturnType<typeof capture>,
  view: AgentView,
  fake: FakeRuntime,
  extra: Partial<ItemWorker> = {},
): ItemWorker & { notes: Notification[] } {
  const notes: Notification[] = [];
  return {
    ctx: c.ctx,
    root: path.join(box.home, "work"),
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
  it("dry by default, pty with SKEP_SESSION_EXEC=1, herdr with the view, --agent wins", () => {
    expect(selectAgentView(undefined, {})).toBe("dry");
    expect(selectAgentView(undefined, { SKEP_SESSION_VIEW: "herdr" })).toBe("dry");
    expect(selectAgentView(undefined, { SKEP_SESSION_EXEC: "1" })).toBe("pty");
    expect(selectAgentView(undefined, { SKEP_SESSION_EXEC: "1", SKEP_SESSION_VIEW: "herdr" })).toBe(
      "herdr",
    );
    for (const flag of ["dry", "pty", "herdr", "native"] as const) {
      expect(selectAgentView(flag, { SKEP_SESSION_EXEC: "1", SKEP_SESSION_VIEW: "herdr" })).toBe(
        flag,
      );
    }
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

  it("reports a final failed state when materialization fails", async () => {
    const dir = await home();
    const c = capture(dir, { cwd: dir });
    const onAgentState = vi.fn();
    await workItem(
      {
        ctx: c.ctx,
        root: path.join(dir, "work"),
        method: "none",
        ask: async () => null,
        onAgentState,
      },
      ITEM,
    );
    expect(onAgentState).toHaveBeenCalledExactlyOnceWith(ITEM.itemId, "failed");
  });

  it("pty: runs the CLI with the prompt as argv, suspends the view around it, commits", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime();
    const log = recordingView();
    const worker = itemWorker(box, c, "pty", fake, { view: log.view, method: "none" });
    const result = await workItem(worker, ITEM);
    expect(fake.ptyRuns).toHaveLength(1);
    const run = fake.ptyRuns[0];
    expect(run?.argv).toEqual(["claude", "add a health check\n"]);
    expect(run?.input).toBe("inherit");
    expect(run?.cwd).toBe(path.join(box.home, "work", "app-I-7-e1"));
    expect(run?.env.SKEP_SESSION_ITEM).toBe("I-7");
    expect(run?.env).not.toHaveProperty("SKEP_HOME");
    // The raw transcript stays in the local journal, 0600.
    expect(path.dirname(run?.transcriptPath ?? "")).toBe(path.join(box.home, "journal"));
    expect((await stat(run?.transcriptPath ?? "")).mode & 0o777).toBe(0o600);
    const suspend = log.events.indexOf("suspend");
    expect(log.events.slice(suspend, suspend + 2)).toEqual(["suspend", "resume"]);
    expect(log.events).toContain("update:running");
    expect(log.events.at(-1)).toBe("update:done");
    expect(result.submit).toMatchObject({ method: "none", state: "local" });
    expect(result.headSha).not.toBe(result.baseSha);
    expect(await gitIn(box.repo, ["show", "skep/session/I-7-e1:feature.txt"], box.env)).toBe(
      "done",
    );
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

  it("pty: no changes reports so and submits nothing", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      pty: async () => ({
        exit: { code: 0, signal: null },
        aborted: false,
        transcript: Buffer.from("nothing to do\n"),
      }),
    });
    const result = await workItem(itemWorker(box, c, "pty", fake), ITEM);
    expect(result.headSha).toBe(result.baseSha);
    expect(result.submit).toMatchObject({ method: "push", state: "skipped" });
    expect(result.summary).toContain("no changes");
    expect(await remoteHas(box, "skep/session/I-7-e1")).toBeNull();
  });

  it("pty: a non-zero exit fails the item without committing", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      pty: async (run) => {
        await writeFile(path.join(run.cwd, "half.txt"), "x\n");
        return { exit: { code: 3, signal: null }, aborted: false, transcript: Buffer.from("") };
      },
    });
    const result = await workItem(itemWorker(box, c, "pty", fake), ITEM);
    expect(result.submit).toMatchObject({ state: "failed" });
    expect(result.headSha).toBe(result.baseSha);
    expect(result.summary).toContain("agent exited 3");
  });

  it("pty: an unavailable PTY falls back to the native CLI and says why", async () => {
    const box = await sandbox();
    const env = await fakeCli(box, "claude");
    const c = capture(box.home, { env, cwd: box.repo });
    const fake = fakeRuntime({
      pty: async () => {
        throw new FakePtyUnavailableError("script(1) not found");
      },
    });
    const result = await workItem(itemWorker(box, c, "pty", fake, { method: "none" }), ITEM);
    expect(c.stderr).toContain("pty is unavailable: script(1) not found");
    expect(result.summary).toContain("ran claude non-interactively");
    expect(result.submit).toMatchObject({ state: "local" });
    const branch = "skep/session/I-7-e1";
    expect(await gitIn(box.repo, ["show", `${branch}:native-args.txt`], box.env)).toBe("-p");
    expect(await gitIn(box.repo, ["show", `${branch}:native-stdin.txt`], box.env)).toBe(
      "add a health check",
    );
  });

  it("a missing runtime module falls back to native", async () => {
    const box = await sandbox();
    const env = await fakeCli(box, "claude");
    const c = capture(box.home, { env, cwd: box.repo });
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
    const env = await fakeCli(box, "codex");
    const c = capture(box.home, { env, cwd: box.repo });
    const worker = itemWorker(box, c, "native", fakeRuntime(), { method: "none" });
    if (worker.agent !== undefined) worker.agent.cli = "codex";
    const result = await workItem(worker, ITEM);
    expect(result.summary).toContain("agent exited 0\nnative output");
    const branch = "skep/session/I-7-e1";
    expect(await gitIn(box.repo, ["show", `${branch}:native-args.txt`], box.env)).toBe("exec\n-");
  });

  it("herdr: start, prompt, wait, read 200 lines; done commits and submits", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          await writeFile(path.join(box.home, "work", "app-I-7-e1", "pane.txt"), "x\n");
          return "done";
        },
        read: async () => `pane ${ESC}[31mred${ESC}[0m ${PLANTED}`,
      },
    });
    const log = recordingView();
    const result = await workItem(itemWorker(box, c, "herdr", fake, { view: log.view }), ITEM);
    const dir = path.join(box.home, "work", "app-I-7-e1");
    expect(fake.herdrCalls).toEqual([
      "probe",
      `start skep-i-7-e1 claude ${dir}`,
      'prompt "add a health check\\n"',
      "wait",
      "read",
    ]);
    expect(result.submit).toMatchObject({ method: "push", state: "pushed" });
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
          await writeFile(path.join(box.home, "work", "app-I-7-e1", "pane.txt"), "x\n");
          return "blocked";
        },
      },
    });
    const log = recordingView("push");
    const worker = itemWorker(box, c, "herdr", fake, {
      view: log.view,
      chooseSubmit: log.view.chooseSubmit,
    });
    const result = await workItem(worker, ITEM);
    expect(result.submit).toEqual({
      method: "push",
      state: "pending",
      branch: "skep/session/I-7-e1",
    });
    expect(result.headSha).toBe(result.baseSha);
    expect(await remoteHas(box, "skep/session/I-7-e1")).toBeNull();
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
    const env = await fakeCli(box, "claude");
    const c = capture(box.home, { env, cwd: box.repo });
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
    expect(await stat(path.join(box.env.HOME ?? "", "native-called"))).toBeTruthy();
  });

  it("herdr: an error after the prompt was accepted fails the item and never re-runs", async () => {
    const box = await sandbox();
    const env = await fakeCli(box, "claude");
    const c = capture(box.home, { env, cwd: box.repo });
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
    await expect(stat(path.join(box.env.HOME ?? "", "native-called"))).rejects.toThrow();
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
  const master = await startMaster({
    listen: { host: HOST, port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
  });
  try {
    const code = master.status().joinCode;
    if (code === null || master.address === null) throw new Error("master has no join code");
    const c = capture(box.home, { env: box.env, cwd: box.repo, ...extra });
    const exit = runCli(
      [
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
      ],
      c.ctx,
    );
    await vi.waitFor(() => expect(master.status().peers).toHaveLength(1), { timeout: 5_000 });
    await master.submitIntent("add a health check");
    await vi.waitFor(() => expect(master.status().intents[0]?.items[0]?.state).toBe("done"), {
      timeout: 10_000,
    });
    const item = master.status().intents[0]?.items[0];
    if (item === undefined) throw new Error("no item");
    await master.close();
    return { item, run: c, exit: await exit };
  } finally {
    await master.close();
  }
}

async function roleDir(box: Sandbox, cli: string): Promise<string> {
  const dir = path.join(box.home, "role");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "AGENT.md"), AGENT_MD(cli));
  return dir;
}

describe("session join with a live agent", () => {
  afterEach(() => setJoinViewFactory(null));

  it("SKEP_SESSION_EXEC=1 selects pty with the AGENT.md CLI from --role-dir", async () => {
    const box = await sandbox();
    box.env = { ...box.env, SKEP_SESSION_EXEC: "1" };
    const fake = fakeRuntime();
    const role = await roleDir(box, "pi");
    const { item, exit, run } = await joinWith(box, ["--submit", "none", "--role-dir", role], {
      agentRuntime: fake.runtime,
    });
    expect(exit).toBe(0);
    expect(fake.ptyRuns.map((r) => r.argv)).toEqual([["pi", "add a health check\n"]]);
    expect(item.result?.submit).toMatchObject({ state: "local" });
    expect(run.stderr).toContain("item I-1: agent pi (pty) running");
    expect(run.stderr).toContain("item I-1: agent pi (pty) done");
  });

  it("the role dir defaults to the current directory", async () => {
    const box = await sandbox();
    await writeFile(path.join(box.repo, "AGENT.md"), AGENT_MD("codex"));
    const fake = fakeRuntime();
    await joinWith(box, ["--submit", "none", "--agent", "pty"], { agentRuntime: fake.runtime });
    expect(fake.ptyRuns[0]?.argv[0]).toBe("codex");
  });

  it("SKEP_SESSION_VIEW=herdr selects herdr and prints the focus command", async () => {
    const box = await sandbox();
    box.env = { ...box.env, SKEP_SESSION_EXEC: "1", SKEP_SESSION_VIEW: "herdr" };
    const fake = fakeRuntime({
      herdr: {
        wait: async () => {
          await writeFile(
            path.join(box.home, "skep", "session", "worktrees", "app-I-1-e1", "h"),
            "",
          );
          return "idle";
        },
      },
    });
    const role = await roleDir(box, "claude");
    const { item, run } = await joinWith(box, ["--submit", "none", "--role-dir", role], {
      agentRuntime: fake.runtime,
    });
    expect(fake.ptyRuns).toHaveLength(0);
    expect(fake.herdrCalls[1]).toContain("start skep-i-1-e1 claude");
    expect(run.stderr).toContain("watch with: herdr agent focus skep-i-1-e1");
    expect(item.result?.submit).toMatchObject({ state: "local" });
  });

  it("--agent dry overrides the variables and never loads the runtime", async () => {
    const box = await sandbox();
    box.env = { ...box.env, SKEP_SESSION_EXEC: "1", SKEP_SESSION_VIEW: "herdr" };
    const fake = fakeRuntime();
    const { item } = await joinWith(box, ["--submit", "none", "--agent", "dry"], {
      agentRuntime: fake.runtime,
    });
    expect(fake.loads).toBe(0);
    expect(await gitIn(box.repo, ["show", "skep/session/I-1-e1:.skep-session-item"], box.env)).toBe(
      "I-1",
    );
    expect(item.result?.summary).toContain("dry run");
  });

  it("--agent herdr blocked: pending result, message printed, notification sent", async () => {
    const box = await sandbox();
    const notes: Notification[] = [];
    const fake = fakeRuntime({ herdr: { wait: async () => "blocked" } });
    const role = await roleDir(box, "claude");
    const { item, run } = await joinWith(
      box,
      ["--submit", "push", "--agent", "herdr", "--role-dir", role],
      { agentRuntime: fake.runtime, notify: async (n) => notes.push(n) },
    );
    expect(item.result?.submit).toMatchObject({ method: "push", state: "pending" });
    expect(run.stderr).toContain(
      "agent skep-i-1-e1 is waiting for you: herdr agent focus skep-i-1-e1",
    );
    expect(notes).toHaveLength(1);
    expect(await remoteHas(box, "skep/session/I-1-e1")).toBeNull();
  });

  it("a missing AGENT.md is a usage error before joining", async () => {
    const box = await sandbox();
    const c = capture(box.home, { env: box.env, cwd: box.repo });
    const exit = await runCli(
      ["session", "join", "--code", "123456789012", "--host", "127.0.0.1:1", "--agent", "pty"],
      c.ctx,
    );
    expect(exit).toBe(2);
    expect(c.stderr).toContain("needs this device's AGENT.md");
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
    const role = await roleDir(box, "claude");
    const { item, run, exit } = await joinWith(
      box,
      ["--ui", "--submit", "ask", "--agent", "pty", "--role-dir", role],
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
