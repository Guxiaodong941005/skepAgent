import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor } from "../exec/redact.js";
import type { Signer } from "../git/signer.js";
import { connectIpc, type IpcClient, signerCallback } from "../ipc/client.js";
import { encodeFrame, type ServerFrame } from "../ipc/protocol.js";
import { type IpcHandlers, IpcServer } from "./ipc-server.js";

const SIGNATURE = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHTlVUVVJF
-----END SSH SIGNATURE-----
`;

/** A signer that never touches a key: the daemon must not need the private key at all. */
function fakeSigner(): Signer & { payloads: Buffer[] } {
  const payloads: Buffer[] = [];
  return {
    principal: "human",
    payloads,
    sign: async (payload) => {
      payloads.push(Buffer.from(payload));
      return SIGNATURE;
    },
  };
}

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: async () => ({ seq: 3, tip: "abc" }),
    log: async () => ({ entries: [] }),
    publish: async () => ({ status: "accepted", seq: 4 }),
    agentStart: async () => ({ started: true }),
    agentStop: async () => ({ stopped: true }),
    logsTail: async (_params, write) => {
      await write({ text: "hello\n" });
      return { lines: 1 };
    },
    doctor: async () => ({ ok: true }),
    ping: async () => ({ pong: true }),
    ...overrides,
  };
}

/** A home under the system temp dir, never `~/.skep`. */
async function home(): Promise<string> {
  const dir = join(tmpdir(), `skep-ipc-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("IpcServer", () => {
  const dirs: string[] = [];
  let server: IpcServer | undefined;
  let client: IpcClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await server?.stop();
    server = undefined;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function start(impl: Partial<IpcHandlers> = {}): Promise<string> {
    const dir = await home();
    dirs.push(dir);
    server = new IpcServer({
      socketPath: join(dir, "skepd.sock"),
      handlers: handlers(impl),
      redactor: new Redactor(),
    });
    await server.start();
    client = await connectIpc(join(dir, "skepd.sock"));
    return dir;
  }

  it("serves a ping round trip", async () => {
    await start();
    const result = await client?.call("ping", {});
    expect(result).toEqual({ ok: true, result: { pong: true } });
  });

  it("round-trips a human publish through the sign callback (AC: fake signer)", async () => {
    const seen: { payload: Buffer; session: string }[] = [];
    await start({
      publish: async (params, session) => {
        // Two write-loop attempts, as the publisher retries against a moved tip (§7.2).
        for (const attempt of [0, 1]) {
          const payload = Buffer.from(`commit bytes ${attempt}\n`);
          const signature = await session.sign(payload);
          seen.push({ payload, session: session.principal });
          expect(signature).toBe(SIGNATURE);
        }
        return { status: "accepted", seq: 7, signer: params.signer };
      },
    });
    const signer = fakeSigner();
    const result = await client?.call(
      "publish",
      {
        intent: {
          kind: "lease.revoke",
          task: "T-20261005-7f3a",
          item: "W1",
          epoch: 2,
          reason: "holder is stale",
        },
        signer: "human",
      },
      { sign: signerCallback(signer) },
    );
    expect(result).toEqual({
      ok: true,
      result: { status: "accepted", seq: 7, signer: "human" },
    });
    // The daemon signed nothing itself: the only payloads signed are the ones it sent over.
    expect(signer.payloads.map((p) => p.toString("utf8"))).toEqual([
      "commit bytes 0\n",
      "commit bytes 1\n",
    ]);
    expect(seen.map((s) => s.session)).toEqual(["human", "human"]);
  });

  it("redacts secrets in results, errors and streamed logs", async () => {
    const secret = "sk-abcdefghijklmnopqrst";
    await start({
      status: async () => ({ note: `leaked ${secret}` }),
      doctor: async () => {
        throw new Error(`failed with ${secret}`);
      },
      logsTail: async (_params, write) => {
        await write({ text: `log ${secret}\n` });
        return { ok: true };
      },
    });
    const status = await client?.call("status", {});
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).toContain("[REDACTED:provider-api-key]");

    const doctor = await client?.call("doctor", {});
    expect(doctor?.ok).toBe(false);
    if (!doctor?.ok) expect(doctor?.error.message).not.toContain(secret);

    const chunks: string[] = [];
    const logs = await client?.call(
      "logs.tail",
      { agent: "mac.coding" },
      {
        onStream: (chunk) => chunks.push(chunk.text),
      },
    );
    expect(logs?.ok).toBe(true);
    expect(chunks.join("")).not.toContain(secret);
    expect(chunks.join("")).toContain("[REDACTED:provider-api-key]");
  });

  it("answers a version mismatch with protocol_version", async () => {
    const dir = await start();
    const reply = await rawExchange(join(dir, "skepd.sock"), { v: 2, id: "c9", method: "ping" });
    expect(reply).toMatchObject({
      v: 1,
      id: "c9",
      ok: false,
      error: { code: "protocol_version" },
    });
  });

  it("rejects a malformed frame and an oversized frame", async () => {
    const dir = await start();
    const socket = join(dir, "skepd.sock");
    const malformed = await rawExchange(socket, "not json\n");
    expect(malformed).toMatchObject({ ok: false, error: { code: "bad_frame" } });

    const huge = `{"v":1,"id":"c1","method":"ping","pad":"${"x".repeat(1024 * 1024)}"}\n`;
    const oversized = await rawText(socket, huge);
    expect(oversized).toContain('"code":"bad_frame"');
    expect(oversized).toContain("1 MiB");
  });

  it("rejects unknown param keys", async () => {
    await start();
    const result = await client?.call("ping", { extra: true } as never);
    expect(result?.ok).toBe(false);
    if (!result?.ok) expect(result?.error.code).toBe("bad_params");
  });

  it("creates the socket as 0600 inside a 0700 directory", async () => {
    const dir = await start();
    const socketStat = await lstat(join(dir, "skepd.sock"));
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    const dirStat = await lstat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing directory and replaces a stale socket", async () => {
    const dir = await home();
    dirs.push(dir);
    await chmod(dir, 0o755);
    await writeFile(join(dir, "skepd.sock"), "");
    // A regular file where the socket should be must not be deleted silently.
    server = new IpcServer({
      socketPath: join(dir, "skepd.sock"),
      handlers: handlers(),
      redactor: new Redactor(),
    });
    await expect(server.start()).rejects.toThrow(/not a socket/);
    await rm(join(dir, "skepd.sock"));

    await server.start();
    const stat = await lstat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("reports a remote agent without streaming logs (D18)", async () => {
    await start({
      logsTail: async (params) => {
        if (params.agent !== "mac.coding") {
          return { remote: true, journal: "journal/vps.coding" };
        }
        return { remote: false };
      },
    });
    const result = await client?.call("logs.tail", { agent: "vps.coding" });
    expect(result).toEqual({ ok: true, result: { remote: true, journal: "journal/vps.coding" } });
  });
});

/** Speak raw bytes to the socket and read one response line. */
function rawExchange(socketPath: string, payload: unknown): Promise<ServerFrame> {
  const line = typeof payload === "string" ? payload : encodeFrame(payload as never);
  return rawText(socketPath, line).then((text) => JSON.parse(text) as ServerFrame);
}

function rawText(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no response"));
    }, 5_000);
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      resolve(data.slice(0, newline));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
