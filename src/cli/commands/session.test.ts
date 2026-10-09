import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";
import {
  encodeFrame,
  expandStartWithMaster,
  FrameDecoder,
  type MasterHandle,
  type MasterOptions,
  parseHostPort,
  pickListenHost,
  type SessionApi,
  type SessionCliContext,
  type SessionStatus,
  type SubHandle,
  type SubOptions,
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
        closed: Promise.resolve(),
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
    expect(await options?.acceptJoin({ device: "pc", address: "1.2.3.4", fingerprint: "x" })).toBe(
      true,
    );
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

  it("asks on stdin and accepts y", async () => {
    const fake = fakeApi();
    const stdin = new PassThrough();
    const c = capture(await home(), { sessionApi: fake.api, stdin });
    const run = runCli(["session", "start", "--repo", "app"], c.ctx);
    await vi.waitFor(() => expect(fake.calls.master).toHaveLength(1));
    const answer = fake.calls.master[0]?.acceptJoin({
      device: "laptop",
      address: "192.168.1.30",
      fingerprint: "abcd-ef01-2345-6789",
    });
    stdin.write("y\n");
    expect(await answer).toBe(true);
    expect(c.stderr).toContain("Accept laptop from 192.168.1.30 fingerprint abcd-ef01-2345-6789?");
    const declined = fake.calls.master[0]?.acceptJoin({
      device: "x",
      address: "1.1.1.1",
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
