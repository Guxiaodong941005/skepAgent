import { createCipheriv, createDecipheriv } from "node:crypto";
import type { Duplex } from "node:stream";
import type { Clock } from "../util/clock.js";
import { encodeFrame, FrameDecoder, MAX_FRAME, parseJson } from "./codec.js";

export class ChannelError extends Error {
  override readonly name = "ChannelError";
}

export class SecureChannel {
  private sendCounter = 0n;
  private receiveCounter = 0n;
  private failure: ChannelError | null = null;
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;

  constructor(sendKey: Buffer, receiveKey: Buffer) {
    if (sendKey.length !== 32 || receiveKey.length !== 32) {
      throw new ChannelError("AES-256-GCM requires 32-byte directional keys");
    }
    this.sendKey = Buffer.from(sendKey);
    this.receiveKey = Buffer.from(receiveKey);
  }

  seal(obj: unknown): Buffer {
    if (this.failure) throw this.failure;
    try {
      const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
      if (plaintext.length > MAX_FRAME - 16)
        throw new ChannelError("Encrypted message exceeds frame limit");
      const cipher = createCipheriv("aes-256-gcm", this.sendKey, nonce(this.sendCounter));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      this.sendCounter += 1n;
      return ciphertext;
    } catch (cause) {
      this.failure = new ChannelError("Unable to seal session message", { cause });
      throw this.failure;
    }
  }

  open(buf: Buffer): unknown {
    if (this.failure) throw this.failure;
    try {
      if (buf.length <= 16 || buf.length > MAX_FRAME)
        throw new ChannelError("Invalid encrypted frame length");
      const cipher = createDecipheriv("aes-256-gcm", this.receiveKey, nonce(this.receiveCounter));
      cipher.setAuthTag(buf.subarray(-16));
      const value = parseJson(Buffer.concat([cipher.update(buf.subarray(0, -16)), cipher.final()]));
      this.receiveCounter += 1n;
      return value;
    } catch (cause) {
      // Counters are implicit on this ordered stream. A replay, gap or reordered frame fails GCM.
      this.failure = new ChannelError("Invalid, tampered or out-of-sequence session frame", {
        cause,
      });
      throw this.failure;
    }
  }
}

function nonce(counter: bigint): Buffer {
  if (counter > 0xffff_ffff_ffff_ffffn) throw new ChannelError("Session nonce counter exhausted");
  const value = Buffer.alloc(12);
  value.writeBigUInt64BE(counter, 4);
  return value;
}

/** Shared stream lifetime management; protocol state remains in master/sub. */
export class SessionWire {
  channel: SecureChannel | null = null;
  active = true;
  private readonly decoder = new FrameDecoder();
  private readonly timers = new Set<AbortController>();
  private cancelSilence: (() => void) | null = null;
  private beatSeq = 0;
  /** Monotonic time of the last frame from the other side (presence display). */
  private lastReceivedMs: number;

  constructor(
    private readonly stream: Duplex,
    readonly clock: Clock,
    onFrame: (frame: Buffer) => void,
    private readonly onClose: (reason: string) => void,
  ) {
    this.lastReceivedMs = clock.monotonicMs();
    stream.on("data", (chunk: Buffer) => {
      if (!this.active) return;
      try {
        if (!Buffer.isBuffer(chunk))
          throw new ChannelError("Session stream must deliver binary data");
        for (const frame of this.decoder.push(chunk)) {
          if (!this.active) break;
          onFrame(frame);
        }
      } catch {
        // Do not expose untrusted JSON or secrets in parser/crypto exception messages.
        this.destroy("protocol_error");
      }
    });
    stream.on("error", () => this.destroy("transport_error"));
    stream.on("end", () => this.destroy("connection_closed"));
    stream.on("close", () => this.destroy("connection_closed"));
  }

  send(obj: unknown): void {
    if (!this.active) throw new ChannelError("Session connection is closed");
    this.stream.write(
      encodeFrame(this.channel ? this.channel.seal(obj) : Buffer.from(JSON.stringify(obj))),
    );
  }

  read(frame: Buffer): unknown {
    return this.channel ? this.channel.open(frame) : parseJson(frame);
  }

  timer(ms: number, fn: () => void): () => void {
    const controller = new AbortController();
    this.timers.add(controller);
    void this.clock
      .sleep(ms, controller.signal)
      .then(() => {
        this.timers.delete(controller);
        if (this.active && !controller.signal.aborted) fn();
      })
      .catch(() => {
        this.timers.delete(controller);
        // Cancellation is expected on normal connection shutdown; other clock errors fail closed.
        if (!controller.signal.aborted) this.destroy("timer_error");
      });
    return () => {
      controller.abort();
      this.timers.delete(controller);
    };
  }

  startHeartbeat(intervalMs: number): void {
    const beat = () => {
      this.send({ type: "heartbeat", seq: this.beatSeq++ });
      this.timer(intervalMs, beat);
    };
    this.timer(intervalMs, beat);
    this.received();
  }

  /** Milliseconds since the other side was last heard from. */
  silenceMs(): number {
    return Math.max(0, this.clock.monotonicMs() - this.lastReceivedMs);
  }

  received(): void {
    this.lastReceivedMs = this.clock.monotonicMs();
    this.cancelSilence?.();
    // Silence is always 30 s, independently of the configurable sending cadence.
    this.cancelSilence = this.timer(30_000, () => this.destroy("heartbeat_timeout"));
  }

  finish(reason: string, final?: unknown): void {
    if (!this.active) return;
    try {
      if (final !== undefined) this.send(final);
      this.stop(reason);
      this.stream.end(() => this.stream.destroy());
    } catch {
      this.destroy("transport_error");
      this.stream.destroy();
    }
  }

  destroy(reason: string): void {
    if (!this.active) return;
    this.stop(reason);
    this.stream.destroy();
  }

  private stop(reason: string): void {
    this.active = false;
    for (const timer of this.timers) timer.abort();
    this.timers.clear();
    this.onClose(reason);
  }
}

export function positiveDuration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0)
    throw new ChannelError("Timer durations must be positive finite milliseconds");
  return result;
}
