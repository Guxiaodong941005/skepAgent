import { describe, expect, it } from "vitest";
import { ChannelError, SecureChannel } from "./channel.js";

function pair() {
  return {
    master: new SecureChannel(Buffer.alloc(32, 1), Buffer.alloc(32, 2)),
    sub: new SecureChannel(Buffer.alloc(32, 2), Buffer.alloc(32, 1)),
  };
}

describe("secure channel", () => {
  it("round-trips UTF-8 JSON with independent counters per direction", () => {
    const { master, sub } = pair();
    const message = { type: "intent", text: "hello 🌍" };
    expect(sub.open(master.seal(message))).toEqual(message);
    expect(sub.open(master.seal(message))).toEqual(message);
    expect(master.open(sub.seal({ type: "heartbeat", seq: 0 }))).toEqual({
      type: "heartbeat",
      seq: 0,
    });
    const fresh = pair();
    expect(fresh.master.seal(message)).not.toEqual(fresh.sub.seal(message));
  });

  it("rejects a tampered tag and fails permanently", () => {
    const { master, sub } = pair();
    const payload = master.seal({ value: 1 });
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1;
    expect(() => sub.open(payload)).toThrow(ChannelError);
    expect(() => sub.open(master.seal({ value: 2 }))).toThrow(ChannelError);
    expect(() => sub.seal({ value: 3 })).toThrow(ChannelError);
  });

  it("rejects replay, skipped frames and reflection", () => {
    const { master, sub } = pair();
    const first = master.seal({ seq: 0 });
    sub.open(first);
    expect(() => sub.open(first)).toThrow(ChannelError);
    const reordered = pair();
    reordered.master.seal({ seq: 0 });
    expect(() => reordered.sub.open(reordered.master.seal({ seq: 1 }))).toThrow(ChannelError);
    const reflected = pair();
    expect(() => reflected.master.open(reflected.master.seal({ seq: 0 }))).toThrow(ChannelError);
  });
});
