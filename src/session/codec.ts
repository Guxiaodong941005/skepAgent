export const MAX_FRAME = 65_536;

export class FrameError extends Error {
  override readonly name = "FrameError";
}

export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length < 1 || payload.length > MAX_FRAME) {
    throw new FrameError(`Frame length must be between 1 and ${MAX_FRAME} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private failure: FrameError | null = null;

  push(chunk: Buffer): Buffer[] {
    if (this.failure) throw this.failure;
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes !== 4) continue;
        const length = this.header.readUInt32BE();
        if (length < 1 || length > MAX_FRAME) {
          this.failure = new FrameError(`Frame length must be between 1 and ${MAX_FRAME} bytes`);
          throw this.failure;
        }
        // Allocate only after validating the header, even for a very large incoming chunk.
        this.payload = Buffer.allocUnsafe(length);
        this.headerBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes === this.payload.length) {
        frames.push(this.payload);
        this.payload = null;
        this.payloadBytes = 0;
      }
    }
    return frames;
  }
}

export function parseJson(payload: Buffer): unknown {
  // Reject malformed UTF-8 instead of silently replacing bytes in authenticated messages.
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
}
