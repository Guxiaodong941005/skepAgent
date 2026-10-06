import { describe, expect, it } from "vitest";
import type { Heartbeat } from "../core/schemas/heartbeat.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { LivenessError, LivenessTracker } from "./liveness.js";

const agent = "mac.coding";
const oid = "a".repeat(40);
const nextOid = "b".repeat(40);
const hb: Heartbeat = {
  schema: "skep.hb/v1",
  agent,
  boot_id: "b_abcd",
  n: 1,
  state: "running",
  task_id: "T-20261005-abcd",
  item: "W1",
  epoch: 1,
  observed_main: "c".repeat(40),
  runtime: "native",
  sent_at: "2026-10-05T00:00:00Z",
};

function fixture() {
  const time = new VirtualTime();
  const clock = new FakeClock(time);
  const tracker = new LivenessTracker(clock);
  return { time, clock, tracker };
}

describe("observer-relative liveness", () => {
  it("requires two valid observations and does not refresh an unchanged value on fetch", async () => {
    const { time, tracker } = fixture();
    expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
    tracker.observe(agent, oid, hb);
    await time.advance(20_000);
    expect(tracker.classify(agent)).toEqual({
      cls: "unknown",
      sinceChangeMs: 20_000,
      bootId: "b_abcd",
    });
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent)).toEqual({
      cls: "live",
      sinceChangeMs: 20_000,
      bootId: "b_abcd",
    });
    await time.advance(300_000);
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent)).toEqual({
      cls: "stale",
      sinceChangeMs: 320_000,
      bootId: "b_abcd",
    });
  });

  it("covers live, unknown, stale and lost at the active interval boundaries", async () => {
    const { time, tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    await time.advance(179_999);
    expect(tracker.classify(agent).cls).toBe("live");
    await time.advance(1);
    expect(tracker.classify(agent).cls).toBe("unknown");
    await time.advance(119_999);
    expect(tracker.classify(agent).cls).toBe("unknown");
    await time.advance(1);
    expect(tracker.classify(agent).cls).toBe("stale");
    await time.advance(599_999);
    expect(tracker.classify(agent).cls).toBe("stale");
    await time.advance(1);
    expect(tracker.classify(agent)).toEqual({
      cls: "lost",
      sinceChangeMs: 900_000,
      bootId: "b_abcd",
    });
  });

  it("uses the 300-second idle cadence and lets lost take precedence at 15 minutes", async () => {
    const { time, tracker } = fixture();
    const idle: Heartbeat = { ...hb, state: "idle", task_id: null, item: null, epoch: null };
    tracker.observe(agent, oid, idle);
    tracker.observe(agent, oid, idle);
    await time.advance(300_000);
    expect(tracker.classify(agent).cls).toBe("live");
    await time.advance(599_999);
    expect(tracker.classify(agent).cls).toBe("live");
    await time.advance(1);
    expect(tracker.classify(agent).cls).toBe("lost");
  });

  it("uses lease presence for paused agents rather than inferring it from state", async () => {
    const { time, tracker } = fixture();
    tracker.observe(agent, oid, { ...hb, state: "paused" });
    tracker.observe(agent, oid, { ...hb, state: "paused" });
    await time.advance(180_000);
    expect(tracker.classify(agent).cls).toBe("unknown");
  });

  it.each(["oid", "n"])("resets the age when %s changes", async (field) => {
    const { time, tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    await time.advance(900_000);
    expect(tracker.classify(agent).cls).toBe("lost");
    tracker.observe(agent, field === "oid" ? nextOid : oid, field === "n" ? { ...hb, n: 2 } : hb);
    expect(tracker.classify(agent)).toEqual({ cls: "live", sinceChangeMs: 0, bootId: "b_abcd" });
  });

  it("treats a new boot as a restart with a fresh two-observation baseline", async () => {
    const { time, tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    await time.advance(900_000);
    const restarted = { ...hb, boot_id: "b_dcba", n: 0 };
    tracker.observe(agent, nextOid, restarted);
    expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0, bootId: "b_dcba" });
    await time.advance(20_000);
    tracker.observe(agent, nextOid, restarted);
    expect(tracker.classify(agent)).toEqual({
      cls: "live",
      sinceChangeMs: 20_000,
      bootId: "b_dcba",
    });
    expect(tracker.alarms()).toEqual([]);
  });

  it("alarms when a superseded boot returns and retains the first evidence", () => {
    const { tracker } = fixture();
    const restarted = { ...hb, boot_id: "b_dcba", n: 0 };
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, nextOid, restarted);
    tracker.observe(agent, "d".repeat(40), { ...hb, n: 2 });
    const alarm = {
      kind: "duplicate-daemon",
      agent,
      bootId: hb.boot_id,
      supersededBy: restarted.boot_id,
    };
    expect(tracker.alarms()).toEqual([alarm]);
    expect(tracker.classify(agent)).toEqual({
      cls: "unknown",
      sinceChangeMs: 0,
      bootId: hb.boot_id,
    });
    tracker.observe(agent, "d".repeat(40), { ...hb, n: 2 });
    expect(tracker.classify(agent).cls).toBe("live");
    tracker.observe(agent, nextOid, restarted);
    tracker.observe(agent, oid, hb);
    expect(tracker.alarms()).toEqual([alarm]);
  });

  it("allows successive new boots but remembers every superseded boot", () => {
    const { tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, nextOid, { ...hb, boot_id: "b_dcba", n: 0 });
    tracker.observe(agent, "d".repeat(40), { ...hb, boot_id: "b_abdc", n: 0 });
    expect(tracker.alarms()).toEqual([]);
    tracker.observe(agent, "e".repeat(40), { ...hb, n: 3 });
    expect(tracker.alarms()).toEqual([
      { kind: "duplicate-daemon", agent, bootId: hb.boot_id, supersededBy: "b_abdc" },
    ]);
  });

  it.each(["unverifiable", "suspend"] as const)(
    "retains boot history and alarms across a liveness reset (%s)",
    (reset) => {
      const { tracker } = fixture();
      tracker.observe(agent, oid, hb);
      tracker.observe(agent, nextOid, { ...hb, boot_id: "b_dcba", n: 0 });
      const resetLiveness = () => {
        if (reset === "unverifiable") tracker.observe(agent, oid, null);
        else tracker.resetAll();
      };
      resetLiveness();
      expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
      tracker.observe(agent, oid, hb);
      const alarms = tracker.alarms();
      expect(alarms).toEqual([
        { kind: "duplicate-daemon", agent, bootId: hb.boot_id, supersededBy: "b_dcba" },
      ]);
      expect(tracker.classify(agent).cls).toBe("unknown");
      resetLiveness();
      expect(tracker.alarms()).toEqual(alarms);
    },
  );

  it("isolates boot history by agent and returns sorted alarm snapshots", () => {
    const { tracker } = fixture();
    for (const id of ["vps.coding", agent]) {
      tracker.observe(id, oid, { ...hb, agent: id });
      tracker.observe(id, nextOid, { ...hb, agent: id, boot_id: "b_dcba", n: 0 });
    }
    expect(tracker.alarms()).toEqual([]);
    for (const id of ["vps.coding", agent]) tracker.observe(id, oid, { ...hb, agent: id });
    const alarms = tracker.alarms();
    expect(alarms.map((alarm) => alarm.agent)).toEqual([agent, "vps.coding"]);
    const first = alarms[0];
    if (!first) throw new Error("Fixture alarm missing");
    first.agent = "vps.testing";
    alarms.pop();
    expect(tracker.alarms().map((alarm) => alarm.agent)).toEqual([agent, "vps.coding"]);
  });

  it("validates returning boot observations before updating history or raising an alarm", () => {
    const { tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, nextOid, { ...hb, boot_id: "b_dcba", n: 0 });
    expect(() => tracker.observe(agent, oid, { ...hb, n: -1 })).toThrow(LivenessError);
    expect(() => tracker.observe(agent, "--invalid", hb)).toThrow(LivenessError);
    expect(() => tracker.observe(agent, oid, { ...hb, agent: "vps.coding" })).toThrow(
      LivenessError,
    );
    expect(tracker.alarms()).toEqual([]);
    expect(tracker.classify(agent).bootId).toBe("b_dcba");
    tracker.observe(agent, oid, hb);
    expect(tracker.alarms()).toHaveLength(1);
  });

  it("ignores sender timestamps and wall-clock jumps in both directions", async () => {
    const { time, clock, tracker } = fixture();
    tracker.observe(agent, oid, { ...hb, sent_at: "2099-01-01T00:00:00Z" });
    tracker.observe(agent, oid, { ...hb, sent_at: "2000-01-01T00:00:00Z" });
    clock.setSkew(10 * 24 * 60 * 60_000);
    expect(tracker.classify(agent).cls).toBe("live");
    await time.advance(300_000);
    clock.setSkew(-10 * 24 * 60 * 60_000);
    expect(tracker.classify(agent)).toEqual({
      cls: "stale",
      sinceChangeMs: 300_000,
      bootId: "b_abcd",
    });
  });

  it("resets all timers after observer suspend and requires two new observations", async () => {
    const { time, clock, tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    const other = { ...hb, agent: "vps.coding", boot_id: "b_dcba" };
    tracker.observe(other.agent, nextOid, other);
    tracker.observe(other.agent, nextOid, other);
    await time.advance(900_000);
    clock.suspend();
    await time.advance(24 * 60 * 60_000);
    clock.resume();
    tracker.resetAll();
    expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
    expect(tracker.classify(other.agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent).cls).toBe("unknown");
    await time.advance(20_000);
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent)).toEqual({
      cls: "live",
      sinceChangeMs: 20_000,
      bootId: "b_abcd",
    });
  });

  it("keeps invalid heartbeat observations unknown and requires valid evidence again", () => {
    const { tracker } = fixture();
    tracker.observe(agent, oid, null);
    tracker.observe(agent, oid, null);
    expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, nextOid, null);
    expect(tracker.classify(agent)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent).cls).toBe("unknown");
    tracker.observe(agent, oid, hb);
    expect(tracker.classify(agent).cls).toBe("live");
  });

  it("tracks agents independently and supports configurable thresholds", async () => {
    const { clock, time } = fixture();
    const tracker = new LivenessTracker(clock, {
      liveFactor: 1,
      staleMs: 120_000,
      lostMs: 180_000,
    });
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    const other = { ...hb, agent: "vps.coding", epoch: null };
    tracker.observe(other.agent, nextOid, other);
    tracker.observe(other.agent, nextOid, other);
    await time.advance(120_000);
    expect(tracker.classify(agent).cls).toBe("stale");
    expect(tracker.classify(other.agent).cls).toBe("live");
    await time.advance(60_000);
    expect(tracker.classify(agent).cls).toBe("lost");
    expect(tracker.classify(other.agent).cls).toBe("lost");
  });

  it.each([
    { liveFactor: 0, staleMs: 300_000, lostMs: 900_000 },
    { liveFactor: 3, staleMs: -1, lostMs: 900_000 },
    { liveFactor: 3, staleMs: 300_000, lostMs: 300_000 },
    { liveFactor: Number.POSITIVE_INFINITY, staleMs: 300_000, lostMs: 900_000 },
  ])("rejects invalid configuration: %j", (cfg) => {
    const { clock } = fixture();
    expect(() => new LivenessTracker(clock, cfg)).toThrow(LivenessError);
  });

  it("rejects mismatched agents and malformed observations without losing prior evidence", () => {
    const { tracker } = fixture();
    tracker.observe(agent, oid, hb);
    tracker.observe(agent, oid, hb);
    expect(() => tracker.observe("vps.coding", oid, hb)).toThrow(LivenessError);
    expect(() => tracker.observe(agent, "--invalid", hb)).toThrow(LivenessError);
    expect(() => tracker.observe(agent, oid, { ...hb, n: -1 })).toThrow(LivenessError);
    expect(tracker.classify(agent).cls).toBe("live");
  });
});
