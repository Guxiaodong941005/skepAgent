import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcServer } from "../daemon/ipc-server.js";
import { Redactor } from "../exec/redact.js";
import { connectIpc, type IpcClient, IpcClientError } from "./client.js";

const SIGNATURE = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHTlVUVVJF
-----END SSH SIGNATURE-----
`;

describe("connectIpc", () => {
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

  it("fails with connect when no daemon is listening", async () => {
    const missing = join(tmpdir(), `skep-ipc-absent-${process.pid}.sock`);
    await expect(connectIpc(missing)).rejects.toBeInstanceOf(IpcClientError);
    await expect(connectIpc(missing)).rejects.toMatchObject({ code: "connect" });
  });

  it("surfaces a refused signature instead of sending one", async () => {
    const dir = join(
      tmpdir(),
      `skep-ipc-cli-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    dirs.push(dir);
    let asked = false;
    server = new IpcServer({
      socketPath: join(dir, "skepd.sock"),
      redactor: new Redactor(),
      signTimeoutMs: 1_000,
      handlers: {
        status: async () => ({}),
        log: async () => ({}),
        publish: async (_params, session) => {
          asked = true;
          await session.sign(Buffer.from("commit\n"));
          return { status: "accepted" };
        },
        agentStart: async () => ({}),
        agentStop: async () => ({}),
        logsTail: async () => ({}),
        doctor: async () => ({}),
        ping: async () => ({ pong: true }),
      },
    });
    await server.start();
    client = await connectIpc(join(dir, "skepd.sock"));

    const refused = client.call(
      "publish",
      { intent: { kind: "task.cancel", task: "T-20261005-7f3a", reason: "no" }, signer: "human" },
      {
        sign: () => Promise.reject(new Error("human declined to sign")),
      },
    );
    await expect(refused).rejects.toThrow(/human declined to sign/);
    expect(asked).toBe(true);

    // Nothing was signed, and the connection survived: a later call still works.
    const ping = await client.call("ping", {});
    expect(ping).toEqual({ ok: true, result: { pong: true } });
  });

  it("answers two sign requests on one publish", async () => {
    const dir = join(
      tmpdir(),
      `skep-ipc-cli-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    dirs.push(dir);
    server = new IpcServer({
      socketPath: join(dir, "skepd.sock"),
      redactor: new Redactor(),
      handlers: {
        status: async () => ({}),
        log: async () => ({}),
        publish: async (_params, session) => {
          const first = await session.sign(Buffer.from("one"));
          const second = await session.sign(Buffer.from("two"));
          return { signatures: [first, second] };
        },
        agentStart: async () => ({}),
        agentStop: async () => ({}),
        logsTail: async () => ({}),
        doctor: async () => ({}),
        ping: async () => ({}),
      },
    });
    await server.start();
    client = await connectIpc(join(dir, "skepd.sock"));
    const seen: string[] = [];
    const result = await client.call(
      "publish",
      { intent: { kind: "plan.approve", task: "T-20261005-7f3a" }, signer: "human" },
      {
        sign: async (payload) => {
          seen.push(Buffer.from(payload).toString("utf8"));
          return SIGNATURE;
        },
      },
    );
    expect(seen).toEqual(["one", "two"]);
    expect(result).toEqual({ ok: true, result: { signatures: [SIGNATURE, SIGNATURE] } });
  });
});
