/**
 * Daemon-side IPC server (ARCHITECTURE §12, §7.4).
 *
 * Listens on the Unix socket at `$SKEP_HOME/skepd.sock` and speaks the NDJSON frames in
 * `src/ipc/protocol.ts`. The directory is 0700 and the socket 0600 by default; D22 permits
 * 0750/0660 with a shared group. Both remain owned by the daemon user and local-only (D18).
 *
 * A `publish` with `signer: "human"` is signed by the CLI, not here. {@link SigningSession}
 * sends a `sign_request` for the commit bytes and waits for the matching `sign_result`; the
 * human private key therefore never enters the daemon.
 *
 * Every byte of a response is passed through the redactor before it is written (ARCHITECTURE
 * §16): handler results, streamed log chunks and error messages alike.
 */

import { chmod, chown, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { Redactor } from "../exec/redact.js";
import { FrameReadError, FrameReader, FrameWriteError, writeFrame } from "../ipc/framing.js";
import {
  type ClientFrame,
  errorFrame,
  IPC_VERSION,
  type IpcMethod,
  MAX_FRAME_BYTES,
  type ParsedRequest,
  ProtocolError,
  parseRequest,
  type RequestFrame,
  resultFrame,
  type ServerFrame,
  SOCKET_DIR_MODE,
  SOCKET_MODE,
} from "../ipc/protocol.js";
import { execFileChecked } from "../util/exec.js";

/**
 * What the daemon does for one accepted request. SK-601 implements this against the real daemon.
 */
export interface IpcHandlers {
  /** `status`: statusView plus liveness and fetch freshness (ARCHITECTURE §12). */
  status(params: Record<string, never>): Promise<unknown>;
  /** `log`: one task's outcomes, optionally starting at `from_seq`. */
  log(params: { task: string; from_seq?: number }): Promise<unknown>;
  /**
   * `publish`: map the spec to a pure intent and publish it. For `signer: "human"` the
   * implementation signs through `session` on every write-loop attempt (ARCHITECTURE §7.2).
   */
  publish(
    params: { intent: unknown; signer: "daemon" | "human" },
    session: SigningSession,
  ): Promise<unknown>;
  /** `agent.start`: register and start the slot for a role directory. */
  agentStart(params: { role_dir: string }): Promise<unknown>;
  /** `agent.stop`: interrupt ladder, then checkpoint. */
  agentStop(params: { role_dir: string }): Promise<unknown>;
  /**
   * `logs.tail`: local agents only (D18). A remote agent yields a result describing where the
   * journal lives instead of any bytes. `follow` keeps calling `write` until it returns false
   * or the connection closes.
   */
  logsTail(
    params: { agent: string; follow?: boolean; tail_bytes?: number },
    write: (chunk: { text: string; eof?: boolean }) => Promise<boolean>,
  ): Promise<unknown>;
  /** `doctor`: the §13.3 pre-flight summary. */
  doctor(params: Record<string, never>): Promise<unknown>;
  /** `ping`: liveness of the socket itself. */
  ping(params: Record<string, never>): Promise<unknown>;
  /** `pull`: fetch the blackboard now. The caller is not trusted for state (D26). */
  pull(params: Record<string, never>): Promise<unknown>;
}

/**
 * The CLI end of one connection, as seen by a handler that needs a human signature.
 * `sign` resolves with the armored signature or rejects when the CLI refuses or vanishes.
 */
export interface SigningSession {
  readonly principal: string;
  sign(payload: Uint8Array): Promise<string>;
}

export interface IpcServerOptions {
  /** Absolute path of the socket file (`skepPaths(home).socket`). */
  socketPath: string;
  handlers: IpcHandlers;
  /** Scrubs responses before they leave the daemon (ARCHITECTURE §16). */
  redactor: Redactor;
  /** Local OS group for both the socket and its directory (ARCHITECTURE §12, D22). */
  group?: string;
  /** Defaults to 0600; 0660 also enables group traversal of the directory (0750). */
  mode?: 0o600 | 0o660;
  /**
   * How long a `sign_request` waits for its `sign_result`. The human signs through an agent,
   * so this bounds a lost CLI rather than the signature itself.
   */
  signTimeoutMs?: number;
  /** Principal the daemon tells the CLI to sign as. Human-signed events are always `human`. */
  humanPrincipal?: string;
}

const DEFAULT_SIGN_TIMEOUT_MS = 60_000;

const SocketPermissionsSchema = z.strictObject({
  group: z
    .string()
    .regex(/^[a-z_][a-z0-9_.-]*$/i)
    .optional(),
  mode: z.union([z.literal(0o600), z.literal(0o660)]).default(SOCKET_MODE),
});

export class IpcServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpcServerError";
  }
}

export class IpcServer {
  private server: Server | undefined;
  private readonly connections = new Set<Connection>();
  private running = false;

  constructor(
    private readonly options: IpcServerOptions,
    private readonly deps: { exec?: typeof execFileChecked } = {},
  ) {}

  /** Create the socket directory and start listening. Replaces a stale socket file. */
  async start(): Promise<void> {
    if (this.running) throw new IpcServerError("IPC server is already listening");
    const { socketPath } = this.options;
    const permissions = SocketPermissionsSchema.safeParse({
      group: this.options.group,
      mode: this.options.mode,
    });
    if (!permissions.success)
      throw new IpcServerError(
        "IPC permissions require a local OS group name and mode 0600 or 0660",
      );
    const { group, mode } = permissions.data;
    const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
    if (!(await lstat(dir)).isDirectory())
      throw new IpcServerError("IPC socket directory must be a real directory, not a symlink");
    // D22: keep the directory private until both inodes have their final group and mode.
    // Explicit chmod also tightens a pre-existing directory, regardless of the umask.
    await enforceMode(dir, SOCKET_DIR_MODE);
    if (group !== undefined) {
      try {
        // chgrp uses the OS group database on both Linux and macOS, including directory services.
        await (this.deps.exec ?? execFileChecked)("/usr/bin/chgrp", [group, dir], {
          env: { LC_ALL: "C" },
        });
      } catch (cause) {
        throw new IpcServerError(
          `Cannot assign IPC socket group ${group}; ensure the group exists and the daemon may use it`,
          { cause },
        );
      }
    }
    const gid = (await lstat(dir)).gid;
    await removeStaleSocket(socketPath);

    const server = createServer((socket) => this.accept(socket));
    // A listener error (for example the socket being unlinked) makes the server unusable.
    // Surface it through the connections rather than throwing on the event loop.
    server.on("error", () => {
      this.running = false;
    });
    let bound = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      bound = true;
      if (group !== undefined || mode === 0o660) await chown(socketPath, -1, gid);
      await enforceMode(socketPath, mode);
      await enforceMode(dir, mode === 0o660 ? 0o750 : SOCKET_DIR_MODE);
      this.server = server;
      this.running = true;
    } catch (cause) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (bound) await rm(socketPath, { force: true });
      throw new IpcServerError(
        "Cannot start IPC socket; check directory ownership and permissions",
        {
          cause,
        },
      );
    }
  }

  /** Stop accepting and close every connection. Safe to call twice. */
  async stop(): Promise<void> {
    this.running = false;
    const server = this.server;
    this.server = undefined;
    for (const connection of this.connections) connection.close();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.options.socketPath, { force: true }).catch(() => undefined);
  }

  get listening(): boolean {
    return this.running;
  }

  private accept(socket: Socket): void {
    if (!this.running) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const connection = new Connection(socket, this.options, () =>
      this.connections.delete(connection),
    );
    this.connections.add(connection);
  }
}

/**
 * One CLI connection. Requests are answered in order; a `sign_result` is routed to the request
 * that asked for it, matched by both the frame id and the `req` token.
 */
class Connection {
  private readonly reader = new FrameReader("client");
  /** `req` token → the request id that asked, so a result answers only its own request. */
  private readonly pendingSigns = new Map<
    string,
    { id: string; settle: (result: string | Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly options: IpcServerOptions,
    private readonly onDone: () => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.finish());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.rejectPending("CLI connection closed");
  }

  private finish(): void {
    this.closed = true;
    this.rejectPending("CLI connection closed");
    this.onDone();
  }

  private rejectPending(message: string): void {
    for (const [req, pending] of this.pendingSigns) {
      this.pendingSigns.delete(req);
      pending.settle(new Error(message));
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let frame: ClientFrame | undefined;
    try {
      for (;;) {
        const next = this.reader.push(chunk);
        chunk = Buffer.alloc(0);
        if (next === null) return;
        frame = next as ClientFrame;
        this.dispatch(frame);
      }
    } catch (error) {
      const code = error instanceof FrameWriteError ? error.code : "bad_frame";
      const message = error instanceof Error ? error.message : String(error);
      const id = error instanceof FrameReadError ? error.id : frame?.id;
      void this.reply(errorFrame(id ?? "?", code, this.redactText(message))).finally(() =>
        this.close(),
      );
    }
  }

  private dispatch(frame: ClientFrame): void {
    if ("sign_result" in frame) {
      const pending = this.pendingSigns.get(frame.sign_result.req);
      // The result must come back on the same request the daemon asked about (§12).
      if (!pending || pending.id !== frame.id) {
        void this.reply(
          errorFrame(frame.id, "bad_frame", `unexpected sign_result for ${frame.sign_result.req}`),
        );
        return;
      }
      this.pendingSigns.delete(frame.sign_result.req);
      pending.settle(frame.sign_result.signature);
      return;
    }
    void this.handle(frame);
  }

  private async handle(frame: RequestFrame): Promise<void> {
    const parsed = parseRequest(frame);
    if (!parsed.ok) {
      await this.reply(errorFrame(frame.id, "bad_params", this.redactText(parsed.error)));
      return;
    }
    try {
      const outcome = await this.invoke(parsed.request);
      if (outcome.done) return;
      await this.reply(resultFrame(frame.id, this.redactValue(outcome.result)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A handler refusing the request (bad signature, unknown agent) names its own code.
      const code = error instanceof ProtocolError ? error.code : "internal";
      await this.reply(errorFrame(frame.id, code, this.redactText(message)));
    }
  }

  /** Run the handler. `done` means it already wrote the terminal frame (a log stream). */
  private async invoke(
    request: ParsedRequest,
  ): Promise<{ done: true } | { done: false; result: unknown }> {
    const { handlers } = this.options;
    switch (request.method) {
      case "status":
        return { done: false, result: await handlers.status({}) };
      case "log":
        return { done: false, result: await handlers.log(request.params) };
      case "publish":
        return {
          done: false,
          result: await handlers.publish(request.params, this.session(request.id)),
        };
      case "agent.start":
        return { done: false, result: await handlers.agentStart(request.params) };
      case "agent.stop":
        return { done: false, result: await handlers.agentStop(request.params) };
      case "logs.tail":
        await this.streamLogs(request.id, request.params);
        return { done: true };
      case "doctor":
        return { done: false, result: await handlers.doctor({}) };
      case "ping":
        return { done: false, result: await handlers.ping({}) };
      case "pull":
        return { done: false, result: await handlers.pull({}) };
      default:
        return assertNever(request);
    }
  }

  /** The signing endpoint for one request id. Each `sign` uses a fresh `req` token. */
  private session(id: string): SigningSession {
    let seq = 0;
    return {
      principal: this.options.humanPrincipal ?? "human",
      sign: (payload) => this.requestSignature(id, payload, seq++),
    };
  }

  private requestSignature(id: string, payload: Uint8Array, seq: number): Promise<string> {
    const req = `s${seq.toString(36)}`;
    const frame: ServerFrame = {
      v: IPC_VERSION,
      id,
      sign_request: {
        req,
        payload_b64: Buffer.from(payload).toString("base64"),
        principal: this.options.humanPrincipal ?? "human",
      },
    };
    return new Promise((resolve, reject) => {
      // Wall-clock bound on a lost CLI, not a protocol deadline: the sim never signs this way.
      const timer = setTimeout(() => {
        this.pendingSigns.delete(req);
        reject(new Error(`CLI did not sign within ${this.signTimeoutMs}ms`));
      }, this.signTimeoutMs);
      this.pendingSigns.set(req, {
        id,
        settle: (result) => {
          clearTimeout(timer);
          if (result instanceof Error) reject(result);
          else resolve(result);
        },
      });
      void this.reply(frame).catch((error: unknown) => {
        clearTimeout(timer);
        this.pendingSigns.delete(req);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private get signTimeoutMs(): number {
    return this.options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  }

  /** Stream redacted chunks, then one terminal result frame. */
  private async streamLogs(
    id: string,
    params: { agent: string; follow?: boolean; tail_bytes?: number },
  ): Promise<void> {
    const write = async (chunk: { text: string; eof?: boolean }): Promise<boolean> => {
      if (this.closed) return false;
      const stream: ServerFrame = {
        v: IPC_VERSION,
        id,
        stream: {
          agent: params.agent,
          text: this.redactText(chunk.text).slice(0, 64 * 1024),
          ...(chunk.eof ? { eof: true } : {}),
        },
      };
      await this.reply(stream);
      return !this.closed;
    };
    const result = await this.options.handlers.logsTail(params, write);
    await this.reply(resultFrame(id, this.redactValue(result)));
  }

  /**
   * Redact the text a handler produced (ARCHITECTURE §16). Strings are scrubbed on their own so
   * a match can never cross a JSON boundary and break the frame; keys are left alone.
   */
  private redactValue(value: unknown): unknown {
    return redactLeaves(value, (text) => this.options.redactor.redact(text));
  }

  private redactText(text: string): string {
    return this.options.redactor.redact(text);
  }

  private reply(frame: ServerFrame): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.resolve();
    if (Buffer.byteLength(JSON.stringify(frame)) + 1 > MAX_FRAME_BYTES) {
      return writeFrame(
        this.socket,
        errorFrame(frame.id, "internal", "response exceeds the 1 MiB frame limit"),
      ).catch(() => undefined);
    }
    // The CLI may have hung up (a refused signature); a late reply is not an error.
    return writeFrame(this.socket, frame).catch(() => undefined);
  }
}

function redactLeaves(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactLeaves(inner, redact);
    return out;
  }
  return value;
}

function assertNever(request: never): never {
  throw new Error(`unhandled method ${(request as { method: IpcMethod }).method}`);
}

/** Replace a leftover socket from a previous run; refuse to delete anything else. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`${socketPath} exists and is not a socket; refusing to replace it`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(socketPath, { force: true });
}

/** `mkdir` only applies the mode when it creates; correct a pre-existing directory too. */
async function enforceMode(target: string, mode: number): Promise<void> {
  await chmod(target, mode);
}
