/**
 * CLI-side IPC client (ARCHITECTURE §12, §7.4).
 *
 * One connection speaks NDJSON to `$SKEP_HOME/skepd.sock`. A `publish` with `signer: "human"`
 * makes the daemon ask this process to sign each write-loop attempt: the callback receives the
 * raw commit bytes and returns an armored SSH signature. The human private key therefore never
 * leaves the CLI process — the daemon only ever sees signatures.
 */

import { createConnection, type Socket } from "node:net";
import type { Signer } from "../git/signer.js";
import { type Clock, systemClock } from "../util/clock.js";
import { FrameReader, FrameWriteError, writeFrame } from "./framing.js";
import {
  type ClientFrame,
  decodeSignPayload,
  type IpcErrorCode,
  type IpcMethod,
  type ParamsOf,
  type ServerFrame,
  type StreamFrame,
} from "./protocol.js";

export interface IpcConnectOptions {
  /**
   * Times each call's deadline, including the wait for a human signature. Defaults to
   * {@link systemClock}; tests and the simulator inject a fake (AGENTS.md: no bare setTimeout).
   */
  clock?: Clock;
}

export interface IpcCallOptions {
  /** Bounds one call, including time spent waiting for a signature. */
  timeoutMs?: number;
  /** Abandon the call (and its connection) when aborted. */
  signal?: AbortSignal;
  /**
   * Signs `sign_request` payloads. Required for `publish` with `signer: "human"`; ignored
   * otherwise. Throw to refuse — the call fails and no signature is sent.
   */
  sign?: (payload: Uint8Array, principal: string) => Promise<string>;
  /** Receives each `logs.tail` chunk as it arrives. */
  onStream?: (chunk: StreamFrame["stream"]) => void;
}

export type IpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: IpcErrorCode; message: string } };

export class IpcClientError extends Error {
  readonly code: IpcErrorCode | "connect" | "timeout" | "aborted" | "closed";

  constructor(code: IpcClientError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpcClientError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

let nextId = 0;

/** A short correlation id, unique within this process. */
function frameId(): string {
  nextId += 1;
  return `c${nextId.toString(36)}`;
}

/** A signer reduced to the callback shape {@link connectIpc} expects. */
export function signerCallback(signer: Signer): IpcCallOptions["sign"] {
  return async (payload, principal) => {
    if (principal !== signer.principal) {
      throw new IpcClientError(
        "bad_frame",
        `daemon asked ${JSON.stringify(principal)} to sign, but this key is ${signer.principal}`,
      );
    }
    return signer.sign(payload);
  };
}

export interface IpcClient {
  /** Send one request and resolve with the daemon's `ok` frame. */
  call<M extends IpcMethod>(
    method: M,
    params: ParamsOf<M>,
    opts?: IpcCallOptions,
  ): Promise<IpcResult>;
  /** Close the socket. In-flight calls reject. */
  close(): void;
}

/**
 * Connect to the daemon socket. The socket stays open for the life of the client; each `call`
 * is one request frame plus its response, and calls are serialized so sign callbacks cannot
 * cross between requests.
 */
export function connectIpc(
  socketPath: string,
  connectOpts: IpcConnectOptions = {},
): Promise<IpcClient> {
  const clock = connectOpts.clock ?? systemClock;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.setNoDelay(true);
      // Flowing mode would emit 'data' and drop bytes; frames are pulled with read().
      socket.pause();
      resolve(new SocketClient(socket, clock));
    });
    socket.once("error", (error) => {
      fail(
        new IpcClientError(
          "connect",
          `cannot connect to skepd at ${socketPath}: ${error.message}`,
          {
            cause: error,
          },
        ),
      );
    });
  });
}

interface Exchange {
  id: string;
  opts: IpcCallOptions;
  resolve: (result: IpcResult) => void;
  reject: (error: IpcClientError) => void;
  /** Aborting cancels the pending deadline sleep once the exchange is settled. */
  timer: AbortController;
  onAbort: () => void;
  done: boolean;
}

class SocketClient implements IpcClient {
  private readonly reader = new FrameReader("server");
  private closed = false;
  /** Calls run one at a time: a sign callback belongs to exactly one in-flight request. */
  private tail: Promise<void> = Promise.resolve();
  private current: Exchange | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly clock: Clock,
  ) {
    socket.on("readable", () => this.read());
    socket.on("error", (error: Error) => {
      this.fail(
        new IpcClientError("closed", `IPC connection failed: ${error.message}`, { cause: error }),
      );
    });
    socket.on("close", () => {
      this.fail(new IpcClientError("closed", "skepd closed the connection"));
    });
  }

  call<M extends IpcMethod>(
    method: M,
    params: ParamsOf<M>,
    opts: IpcCallOptions = {},
  ): Promise<IpcResult> {
    const run = this.tail.then(() => this.exchange(method, params, opts));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.closed = true;
    this.socket.end();
  }

  private exchange<M extends IpcMethod>(
    method: M,
    params: ParamsOf<M>,
    opts: IpcCallOptions,
  ): Promise<IpcResult> {
    if (this.closed) return Promise.reject(new IpcClientError("closed", "IPC client is closed"));
    const id = frameId();
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const exchange: Exchange = {
        id,
        opts,
        resolve,
        reject,
        timer: new AbortController(),
        onAbort: () => {
          this.socket.destroy();
          this.fail(new IpcClientError("aborted", "IPC call aborted"));
        },
        done: false,
      };
      if (opts.signal?.aborted) {
        exchange.onAbort();
        return;
      }
      this.armDeadline(exchange, timeoutMs);
      opts.signal?.addEventListener("abort", exchange.onAbort, { once: true });
      this.current = exchange;
      writeFrame(this.socket, { v: 1, id, method, params }).then(
        () => this.read(),
        (error: unknown) => this.fail(asClientError(error)),
      );
    });
  }

  /**
   * The call deadline on the injected clock (SK-602 review note 2). The sleep is cancelled when
   * the exchange settles; that cancellation is the only expected rejection, so any other error
   * fails the call rather than being swallowed.
   */
  private armDeadline(exchange: Exchange, timeoutMs: number): void {
    this.clock.sleep(timeoutMs, exchange.timer.signal).then(
      () => {
        if (exchange.done) return;
        this.socket.destroy();
        this.fail(new IpcClientError("timeout", `skepd did not answer within ${timeoutMs}ms`));
      },
      (error: unknown) => {
        if (exchange.timer.signal.aborted) return;
        this.fail(asClientError(error));
      },
    );
  }

  /** Pull buffered bytes and handle every complete frame they contain. */
  private read(): void {
    const exchange = this.current;
    if (!exchange || exchange.done) return;
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = this.socket.read() as Buffer | null;
      if (chunk === null) break;
      chunks.push(chunk);
    }
    if (chunks.length === 0) return;
    try {
      let pending: Buffer | null = Buffer.concat(chunks);
      for (;;) {
        const frame = this.reader.push(pending) as ServerFrame | null;
        pending = Buffer.alloc(0);
        if (frame === null) return;
        if (frame.id !== exchange.id) {
          this.fail(
            new IpcClientError(
              "bad_frame",
              `skepd answered ${JSON.stringify(frame.id)}, expected ${JSON.stringify(exchange.id)}`,
            ),
          );
          return;
        }
        this.onFrame(exchange, frame);
        if (exchange.done) return;
      }
    } catch (error) {
      this.fail(asClientError(error));
    }
  }

  private onFrame(exchange: Exchange, frame: ServerFrame): void {
    if ("stream" in frame) {
      exchange.opts.onStream?.(frame.stream);
      return;
    }
    if ("sign_request" in frame) {
      void this.answerSign(exchange, frame);
      return;
    }
    exchange.done = true;
    this.current = undefined;
    exchange.timer.abort();
    exchange.opts.signal?.removeEventListener("abort", exchange.onAbort);
    if (frame.ok) exchange.resolve({ ok: true, result: frame.result });
    else exchange.resolve({ ok: false, error: frame.error });
  }

  private async answerSign(
    exchange: Exchange,
    frame: Extract<ServerFrame, { sign_request: unknown }>,
  ): Promise<void> {
    if (!exchange.opts.sign) {
      this.fail(
        new IpcClientError("bad_frame", "skepd asked for a signature but no signer was given"),
      );
      return;
    }
    try {
      const payload = decodeSignPayload(frame.sign_request.payload_b64);
      const signature = await exchange.opts.sign(payload, frame.sign_request.principal);
      if (exchange.done) return;
      const reply: ClientFrame = {
        v: 1,
        id: exchange.id,
        sign_result: { req: frame.sign_request.req, signature },
      };
      await writeFrame(this.socket, reply);
    } catch (error) {
      this.fail(asClientError(error));
    }
  }

  private fail(error: IpcClientError): void {
    const exchange = this.current;
    if (!exchange || exchange.done) return;
    exchange.done = true;
    this.current = undefined;
    exchange.timer.abort();
    exchange.opts.signal?.removeEventListener("abort", exchange.onAbort);
    exchange.reject(error);
  }
}

function asClientError(error: unknown): IpcClientError {
  if (error instanceof IpcClientError) return error;
  if (error instanceof FrameWriteError) return new IpcClientError(error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  return new IpcClientError("bad_frame", message, { cause: error });
}
