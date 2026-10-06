/**
 * NDJSON framing shared by the daemon server and the CLI client (ARCHITECTURE §12).
 *
 * A frame is one JSON object plus its trailing newline, and the whole line counts toward the
 * 1 MiB cap — an oversized line is rejected without being parsed, so a peer cannot make this
 * process buffer an unbounded amount. Bytes are counted in UTF-8, which is what the socket
 * carries.
 */

import type { Socket } from "node:net";
import {
  type ClientFrame,
  decodeFrame,
  encodeFrame,
  type IpcErrorCode,
  MAX_FRAME_BYTES,
  type ServerFrame,
} from "./protocol.js";

export class FrameWriteError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "FrameWriteError";
    this.code = code;
  }
}

/** A frame the peer sent that cannot be accepted. `id` is its correlation id, when it had one. */
export class FrameReadError extends FrameWriteError {
  readonly id: string | undefined;

  constructor(code: IpcErrorCode, message: string, id: string | undefined) {
    super(code, message);
    this.name = "FrameReadError";
    this.id = id;
  }
}

/** One direction of an NDJSON stream. `side` is which peer's frames are expected. */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private failed: FrameWriteError | undefined;

  constructor(private readonly side: "client" | "server") {}

  /**
   * Accept newly read bytes and return the next complete, valid frame, or null when more bytes
   * are needed. A protocol failure sticks: later pushes rethrow it so a caller cannot resume a
   * stream it has already been told is corrupt.
   */
  push(chunk: Buffer | null): (ClientFrame | ServerFrame) | null {
    if (this.failed) throw this.failed;
    if (chunk !== null && chunk.length > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
    const newline = this.buffer.indexOf(0x0a);
    if (newline === -1) {
      if (this.buffer.length > MAX_FRAME_BYTES) this.fail("frame exceeds 1 MiB without a newline");
      return null;
    }
    const lineBytes = newline + 1;
    if (lineBytes > MAX_FRAME_BYTES) this.fail(`frame is ${lineBytes} bytes; the limit is 1 MiB`);
    const line = this.buffer.subarray(0, newline).toString("utf8");
    this.buffer = this.buffer.subarray(lineBytes);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.fail(`frame is not JSON: ${(error as Error).message}`);
    }
    const decoded = decodeFrame(value, this.side);
    if (!decoded.frame) {
      // Keep the correlation id: a version mismatch must still be answerable (§12).
      const error = decoded.error ?? new FrameWriteError("bad_frame", "frame rejected");
      const tagged = new FrameReadError(error.code, error.message, decoded.id);
      this.failed = tagged;
      this.buffer = Buffer.alloc(0);
      throw tagged;
    }
    return decoded.frame;
  }

  /** Bytes of an unfinished line still held. */
  get pending(): number {
    return this.buffer.length;
  }

  private fail(message: string, code: IpcErrorCode = "bad_frame"): never {
    this.failed = new FrameWriteError(code, message);
    this.buffer = Buffer.alloc(0);
    throw this.failed;
  }
}

/** Write one frame. Rejects when the socket reports an error before the bytes are flushed. */
export function writeFrame(socket: Socket, frame: ClientFrame | ServerFrame): Promise<void> {
  const line = encodeFrame(frame);
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
    return Promise.reject(new FrameWriteError("bad_frame", "refusing to send a frame over 1 MiB"));
  }
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new FrameWriteError("unavailable", "connection is closed"));
      return;
    }
    socket.write(line, "utf8", (error) => (error ? reject(error) : resolve()));
  });
}
