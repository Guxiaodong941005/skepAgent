import { describe, expect, it, vi } from "vitest";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { FakeHintChannel } from "./fake-hint.js";
import type { Hint, HintChannel } from "./types.js";

const tip: Hint = {
  v: 1,
  kind: "tip",
  topic: "a".repeat(26),
  ref: "main",
  sha: "a".repeat(40),
};
const wake: Hint = { v: 1, kind: "wake", topic: tip.topic, device: "vps" };

function fixture() {
  const time = new VirtualTime();
  const clock = new FakeClock(time, { wallStartMs: 10_000, skewMs: 1_000 });
  const channel = new FakeHintChannel(clock);
  return { time, clock, channel };
}

describe("FakeHintChannel", () => {
  it("implements HintChannel and reports its lifecycle state", async () => {
    const { channel } = fixture();
    const contract: HintChannel = channel;
    expect(contract.name).toBe("fake");
    expect(contract.health()).toEqual({ connected: false, lastMessageMonoMs: null });
    await contract.start(vi.fn());
    expect(contract.health()).toEqual({ connected: true, lastMessageMonoMs: null });
    await contract.stop();
    await contract.stop();
    expect(contract.health()).toEqual({ connected: false, lastMessageMonoMs: null });
  });

  it("delivers both hint variants explicitly and records injected monotonic receipt time", async () => {
    const { time, clock, channel } = fixture();
    const onHint = vi.fn();
    await channel.start(onHint);
    expect(channel.emit(tip)).toBe(true);
    expect(onHint).toHaveBeenNthCalledWith(1, tip);
    expect(channel.health().lastMessageMonoMs).toBe(0);
    await time.advance(42);
    expect(channel.emit(wake)).toBe(true);
    expect(onHint).toHaveBeenNthCalledWith(2, wake);
    expect(channel.health().lastMessageMonoMs).toBe(42);
    expect(clock.nowMs()).toBe(11_042);
  });

  it("discards a publication made before start instead of replaying it on restart", async () => {
    // Documented (SK-308 review note 2): publishing before `start()` is a dropped hint, not a
    // queued one, so a test that forgets to start the channel fails visibly.
    const { channel } = fixture();
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    expect(channel.published).toEqual([]);
    await channel.start(vi.fn());
    expect(channel.published).toEqual([]);
    await channel.publish(wake);
    expect(channel.published).toEqual([wake]);
  });

  it("records valid publications without echoing them or updating receipt time", async () => {
    const { channel } = fixture();
    const onHint = vi.fn();
    await channel.start(onHint);
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    await expect(channel.publish(wake)).resolves.toBeUndefined();
    expect(channel.published).toEqual([tip, wake]);
    expect(onHint).not.toHaveBeenCalled();
    expect(channel.health().lastMessageMonoMs).toBeNull();
  });

  it("drops hints and publications while stopped without buffering them on restart", async () => {
    const { channel } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    expect(channel.emit(tip)).toBe(false);
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    await channel.start(first);
    channel.emit(wake);
    await channel.stop();
    expect(channel.emit(tip)).toBe(false);
    await expect(channel.publish(tip)).resolves.toBeUndefined();
    await channel.start(second);
    expect(second).not.toHaveBeenCalled();
    expect(channel.emit(tip)).toBe(true);
    expect(first).toHaveBeenCalledExactlyOnceWith(wake);
    expect(second).toHaveBeenCalledExactlyOnceWith(tip);
    expect(channel.published).toEqual([]);
  });

  it("replaces the callback on repeated start instead of adding duplicate subscriptions", async () => {
    const { channel } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    await channel.start(first);
    await channel.start(second);
    channel.emit(tip);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(tip);
  });

  it.each([
    { ...tip, kind: "mailbox" },
    { ...tip, payload: "example" },
    { ...wake, credentials: "example" },
    { ...tip, sha: "invalid" },
    { ...tip, topic: "a".repeat(1024) },
  ])(
    "drops invalid input without delivering, recording, or rejecting publication: %j",
    async (hint) => {
      const { time, channel } = fixture();
      const onHint = vi.fn();
      await channel.start(onHint);
      channel.emit(tip);
      await time.advance(10);
      expect(channel.emit(hint)).toBe(false);
      // Runtime callers can bypass TypeScript; even those failures must not reject publish (§17.3).
      await expect(channel.publish(hint as Hint)).resolves.toBeUndefined();
      expect(onHint).toHaveBeenCalledExactlyOnceWith(tip);
      expect(channel.published).toEqual([]);
      expect(channel.health().lastMessageMonoMs).toBe(0);
    },
  );

  it("allows forged SHAs, replays, and a 100-hint burst for downstream rate-limit tests", async () => {
    const { time, channel } = fixture();
    const onHint = vi.fn();
    const forged: Hint = { ...tip, sha: "f".repeat(40) };
    await channel.start(onHint);
    for (let index = 0; index < 100; index++) {
      expect(channel.emit(forged)).toBe(true);
      await time.advance(10);
    }
    expect(onHint).toHaveBeenCalledTimes(100);
    expect(channel.health().lastMessageMonoMs).toBe(990);
    expect(channel.published).toEqual([]);
  });

  it("copies validated hints so caller mutations cannot alter delivery or publication history", async () => {
    const { channel } = fixture();
    const received: Hint[] = [];
    await channel.start((hint) => received.push(hint));
    const incoming = { ...tip };
    const outgoing = { ...wake };
    channel.emit(incoming);
    await channel.publish(outgoing);
    incoming.sha = "b".repeat(40);
    outgoing.device = "mac";
    expect(received).toEqual([tip]);
    expect(channel.published).toEqual([wake]);
  });

  it("keeps the last receipt across restart and returns independent health snapshots", async () => {
    const { time, channel } = fixture();
    await channel.start(vi.fn());
    await time.advance(5);
    channel.emit(tip);
    const snapshot = channel.health();
    snapshot.lastMessageMonoMs = 100;
    snapshot.connected = false;
    expect(channel.health()).toEqual({ connected: true, lastMessageMonoMs: 5 });
    await channel.stop();
    expect(channel.health()).toEqual({ connected: false, lastMessageMonoMs: 5 });
    await channel.start(vi.fn());
    expect(channel.health()).toEqual({ connected: true, lastMessageMonoMs: 5 });
  });
});
