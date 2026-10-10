// Control client outcome classification (review R1): a request that never left is
// "unreachable"; an intent whose reply was lost has an unknown outcome.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skepPaths } from "../../config/paths.js";
import { systemClock } from "../../util/clock.js";
import type { CliContext } from "../context.js";
import {
  ControlConnectionError,
  clearStaleSessionFile,
  controlRequest,
  encodeFrame,
  FrameDecoder,
  fetchSessionStatusAt,
  INTENT_OUTCOME_UNKNOWN,
  submitIntentAt,
} from "./session.js";

const TOKEN = "c".repeat(32);
const servers: net.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A loopback control port that reads one request, then does `answer` with the socket. */
async function server(answer: (socket: net.Socket) => void): Promise<number> {
  const listener = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      if (decoder.push(chunk).length > 0) answer(socket);
    });
  });
  servers.push(listener);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return (listener.address() as net.AddressInfo).port;
}

/** A loopback port with nothing listening: bind, read the port, close. */
async function closedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as net.AddressInfo;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function reply(socket: net.Socket, value: unknown): void {
  socket.end(encodeFrame(Buffer.from(JSON.stringify(value))));
}

describe("controlRequest requestSent", () => {
  it("is false when the connection is refused", async () => {
    const port = await closedPort();
    const error = await controlRequest(
      { host: "127.0.0.1", port },
      { type: "control", v: 1, token: TOKEN, op: "status" },
      systemClock,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlConnectionError);
    expect((error as ControlConnectionError).requestSent).toBe(false);
  });

  it("is true when the connection closes after the request was written", async () => {
    const port = await server((socket) => socket.destroy());
    const error = await controlRequest(
      { host: "127.0.0.1", port },
      { type: "control", v: 1, token: TOKEN, op: "status" },
      systemClock,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlConnectionError);
    expect((error as ControlConnectionError).requestSent).toBe(true);
  });
});

describe("submitIntentAt outcome", () => {
  it("reports a refused connection as unreachable (never sent)", async () => {
    const port = await closedPort();
    await expect(
      submitIntentAt({ listen: `127.0.0.1:${port}`, token: TOKEN }, "add a health check"),
    ).rejects.toMatchObject({ code: "session_unreachable" });
  });

  it("reports a lost reply as an unknown outcome", async () => {
    const port = await server((socket) => socket.destroy());
    const error = await submitIntentAt(
      { listen: `127.0.0.1:${port}`, token: TOKEN },
      "add a health check",
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: INTENT_OUTCOME_UNKNOWN });
    expect((error as Error).message).toContain("may have been accepted");
  });

  it("reports an ok reply with a malformed id as an unknown outcome", async () => {
    const port = await server((socket) =>
      reply(socket, { type: "control-result", ok: true, result: { nope: 1 } }),
    );
    await expect(
      submitIntentAt({ listen: `127.0.0.1:${port}`, token: TOKEN }, "add a health check"),
    ).rejects.toMatchObject({ code: INTENT_OUTCOME_UNKNOWN });
  });

  it("keeps an explicit token rejection as a rejection", async () => {
    const port = await server((socket) =>
      reply(socket, {
        type: "control-result",
        ok: false,
        error: { code: "bad_token", message: "Invalid session control token" },
      }),
    );
    await expect(
      submitIntentAt({ listen: `127.0.0.1:${port}`, token: TOKEN }, "add a health check"),
    ).rejects.toMatchObject({ code: "bad_token" });
  });

  it("keeps a lost status reply as plain unreachable (read-only)", async () => {
    const port = await server((socket) => socket.destroy());
    await expect(
      fetchSessionStatusAt({ listen: `127.0.0.1:${port}`, token: TOKEN }),
    ).rejects.toMatchObject({ code: "session_unreachable" });
  });
});

describe("clearStaleSessionFile", () => {
  async function home(content?: string): Promise<{ ctx: CliContext; file: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-clean-"));
    roots.push(dir);
    const file = path.join(dir, "session.json");
    if (content !== undefined) await writeFile(file, content);
    const ctx = { env: {}, paths: skepPaths(dir) } as unknown as CliContext;
    return { ctx, file };
  }

  it("reports none when no session.json exists", async () => {
    const { ctx } = await home();
    expect(await clearStaleSessionFile(ctx, systemClock)).toEqual({ kind: "none" });
  });

  it("removes a file whose master no longer answers", async () => {
    const port = await closedPort();
    const listen = `127.0.0.1:${port}`;
    const { ctx, file } = await home(`${JSON.stringify({ listen, token: TOKEN })}\n`);
    expect(await clearStaleSessionFile(ctx, systemClock)).toEqual({ kind: "removed", listen });
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("removes a corrupt file", async () => {
    const { ctx, file } = await home("{not json");
    expect(await clearStaleSessionFile(ctx, systemClock)).toEqual({
      kind: "removed",
      listen: null,
    });
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("keeps a valid publication that replaced a corrupt file after it was read (review B3)", async () => {
    const { ctx, file } = await home("{not json");
    const fresh = `${JSON.stringify({ listen: "127.0.0.1:7419", token: "d".repeat(32) })}\n`;
    const result = await clearStaleSessionFile(ctx, systemClock, {
      beforeRemove: () => writeFile(file, fresh),
    });
    expect(result).toEqual({ kind: "replaced" });
    expect(await readFile(file, "utf8")).toBe(fresh);
    expect(await readdir(path.dirname(file))).toEqual(["session.json"]);
  });

  it("keeps a new token published between the dead-master check and the unlink (review B3)", async () => {
    const port = await closedPort();
    const listen = `127.0.0.1:${port}`;
    const { ctx, file } = await home(`${JSON.stringify({ listen, token: TOKEN })}\n`);
    const fresh = `${JSON.stringify({ listen, token: "d".repeat(32) })}\n`;
    const result = await clearStaleSessionFile(ctx, systemClock, {
      beforeRemove: () => writeFile(file, fresh),
    });
    expect(result).toEqual({ kind: "replaced" });
    expect(await readFile(file, "utf8")).toBe(fresh);
  });

  it("keeps a publication that lands while the stale file is moved aside", async () => {
    const port = await closedPort();
    const listen = `127.0.0.1:${port}`;
    const { ctx, file } = await home(`${JSON.stringify({ listen, token: TOKEN })}\n`);
    const fresh = `${JSON.stringify({ listen, token: "d".repeat(32) })}\n`;
    const result = await clearStaleSessionFile(ctx, systemClock, {
      afterMoveAside: () => writeFile(file, fresh),
    });
    // The stale bytes were the ones moved aside and removed; the new file was never touched.
    expect(result).toEqual({ kind: "removed", listen });
    expect(await readFile(file, "utf8")).toBe(fresh);
    expect(await readdir(path.dirname(file))).toEqual(["session.json"]);
  });

  it("keeps the file of an endpoint that answers with a malformed reply", async () => {
    const port = await server((socket) => socket.end(encodeFrame(Buffer.from("not json"))));
    const listen = `127.0.0.1:${port}`;
    const { ctx, file } = await home(`${JSON.stringify({ listen, token: TOKEN })}\n`);
    expect(await clearStaleSessionFile(ctx, systemClock)).toEqual({ kind: "live", listen });
    expect(await readFile(file, "utf8")).toContain(listen);
  });

  it("keeps the file of a master that answers", async () => {
    const port = await server((socket) =>
      reply(socket, { type: "control-result", ok: true, result: {} }),
    );
    const listen = `127.0.0.1:${port}`;
    const { ctx, file } = await home(`${JSON.stringify({ listen, token: TOKEN })}\n`);
    expect(await clearStaleSessionFile(ctx, systemClock)).toEqual({ kind: "live", listen });
    expect(await readFile(file, "utf8")).toContain(listen);
  });
});
