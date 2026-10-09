import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMaster } from "../../session/index.js";
import type { ItemStatus } from "../../session/messages.js";
import { runCli } from "../program.js";
import {
  encodeFrame,
  expandStartWithMaster,
  FrameDecoder,
  loadSubmitPolicy,
  type MasterHandle,
  type MasterOptions,
  materializeItem,
  parseHostPort,
  pickListenHost,
  type SessionApi,
  type SessionCliContext,
  type SessionStatus,
  type SubHandle,
  type SubOptions,
  sessionBranch,
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
