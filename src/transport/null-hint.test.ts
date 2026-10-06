import { describe, expect, it, vi } from "vitest";
import { NullHintChannel } from "./null-hint.js";
import type { Hint, HintChannel } from "./types.js";

const tip: Hint = {
  v: 1,
  kind: "tip",
  topic: "a".repeat(26),
  ref: "main",
  sha: "a".repeat(40),
};
const wake: Hint = { v: 1, kind: "wake", topic: tip.topic, device: "mac" };

describe("NullHintChannel", () => {
  it("implements the channel contract and stays disconnected through every lifecycle call", async () => {
    const channel: HintChannel = new NullHintChannel();
    const onHint = vi.fn();
    const disconnected = { connected: false, lastMessageMonoMs: null };

    expect(channel.name).toBe("null");
    expect(channel.health()).toEqual(disconnected);
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    await expect(channel.stop()).resolves.toBeUndefined();
    await expect(channel.start(onHint)).resolves.toBeUndefined();
    expect(channel.health()).toEqual(disconnected);
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    await expect(channel.publish(wake)).resolves.toBeUndefined();
    expect(channel.health()).toEqual(disconnected);
    await expect(channel.stop()).resolves.toBeUndefined();
    expect(channel.health()).toEqual(disconnected);
    expect(onHint).not.toHaveBeenCalled();
  });

  it("tolerates repeated starts, stops, and restarts without delivering hints", async () => {
    const channel = new NullHintChannel();
    const first = vi.fn();
    const second = vi.fn();
    await channel.start(first);
    await channel.start(second);
    await channel.stop();
    await channel.stop();
    await channel.start(first);
    await channel.publish(wake);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(channel.health()).toEqual({ connected: false, lastMessageMonoMs: null });
  });

  it("returns a health snapshot that callers cannot use to change the channel", () => {
    const channel = new NullHintChannel();
    const snapshot = channel.health();
    snapshot.connected = true;
    snapshot.lastMessageMonoMs = 1;
    expect(channel.health()).toEqual({ connected: false, lastMessageMonoMs: null });
  });
});
