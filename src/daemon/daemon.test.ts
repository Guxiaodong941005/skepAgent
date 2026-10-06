import { describe, expect, it, vi } from "vitest";
import { fakeEventId, LogBuilder } from "../../test/helpers/log-builder.js";
import { LivenessTracker } from "../blackboard/liveness.js";
import type { PublishResult } from "../blackboard/publisher.js";
import { type SyncAlarm, SyncError } from "../blackboard/sync.js";
import { draft, type Intent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import type { Signer } from "../git/signer.js";
import { SuspendDetector } from "../lease/suspend.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { NullHintChannel } from "../transport/null-hint.js";
import { Daemon, type DaemonDependencies } from "./daemon.js";
import { SlotRegistry } from "./slots.js";

async function fixture(overrides: Partial<DaemonDependencies> = {}) {
  const time = new VirtualTime();
  const clock = new FakeClock(time);
  const order: string[] = [];
  const state = replay(new LogBuilder().entries);
  const slots = new SlotRegistry({
    device: "mac",
    resolveUser: async () => ({}),
    loadPolicy: async () => ({
      file: "AGENT.md",
      body: "Implement assigned work.",
      frontMatter: {
        schema: "skep.agent/v1",
        role: "coding",
        agent_cli: "codex",
        cli_version: "test",
        repos: ["https://example.invalid/code.git"],
        capabilities: [],
        requires_local: [],
        max_parallel_items: 1,
        budgets: { max_invocation_minutes: 1 },
      },
    }),
    adapter: () => ({
      cli: "codex",
      probe: async () => ({ ok: true, version: "test", detail: "Test" }),
      invoke: vi.fn(),
    }),
  });
  await slots.start({
    roleDir: ".skep-sim/role",
    home: process.cwd(),
    user: "skep",
    path: "agent-bin",
  });
  let alarmListener: (alarm: SyncAlarm) => void = () => {};
  const sync = {
    current: () => ({
      state: structuredClone(state),
      tip: state.tip,
      seq: state.seq,
      fetchedAtMonoMs: 0,
      invalidCount: 0,
    }),
    observeNow: vi.fn(async () => {
      order.push("sync");
      return state;
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onState: vi.fn(() => () => {}),
    onAlarm: (listener: typeof alarmListener) => {
      alarmListener = listener;
      return () => {};
    },
  };
  const duties = {
    heldLeases: vi.fn(() => []),
    discardStale: vi.fn(async () => {
      order.push("stale");
    }),
    tick: vi.fn(() => {
      order.push("duties");
    }),
    setPaused: vi.fn(),
    stop: vi.fn(async () => {}),
    stopSlot: vi.fn(async () => {}),
  };
  const suspend = new SuspendDetector(clock, 20_000);
  const original = suspend.tick.bind(suspend);
  vi.spyOn(suspend, "tick").mockImplementation(() => {
    order.push("suspend");
    return original();
  });
  const liveness = new LivenessTracker(clock);
  const reset = vi.spyOn(liveness, "resetAll");
  const hints = new NullHintChannel();
  const hint = vi.spyOn(hints, "publish").mockImplementation(async () => {
    order.push("hint");
  });
  const beat = vi.fn(async () => {
    order.push("heartbeat");
  });
  const publisher = {
    publish: vi.fn(
      async (
        _intent: Intent,
        _options?: { signer?: Signer; eventId?: string },
      ): Promise<PublishResult> => {
        order.push("publish");
        return { status: "accepted" as const, eventId: fakeEventId(601), seq: 1 };
      },
    ),
  };
  const notify = vi.fn(async () => {});
  const resolveIntent = vi.fn<(spec: unknown) => Intent | null>(() => () => null);
  const logsTail = vi.fn(async () => ({ text: "Example local log\n" }));
  const daemon = new Daemon({
    sync,
    publisher,
    duties,
    slots,
    suspend,
    liveness,
    heartbeat: () => ({ beat }),
    clock,
    random: { bytes: (n) => new Uint8Array(n) },
    hints,
    notify,
    resolveIntent,
    logsTail,
    slotConfig: (roleDir) => ({ roleDir, home: process.cwd(), user: "skep", path: "agent-bin" }),
    ...overrides,
  });
  return {
    daemon,
    resolveIntent,
    logsTail,
    slots,
    time,
    clock,
    state,
    order,
    sync,
    duties,
    suspend,
    liveness,
    reset,
    hints,
    hint,
    beat,
    publisher,
    notify,
    alarm: (value: SyncAlarm) => alarmListener(value),
  };
}
const intent = () =>
  draft(
    "agent.registered",
    null,
    "mac.coding",
    {
      role: "coding",
      agent_cli: "codex",
      cli_version: "test",
      capabilities: [],
      requires_local: [],
      max_parallel_items: 1,
    },
    {},
  );
describe("daemon tick", () => {
  it("binds SK-602's SigningSession directly and refuses invalid intent specs", async () => {
    const f = await fixture();
    const session = { principal: "human", sign: vi.fn() };
    const publication = f.daemon
      .handlers()
      .publish({ intent: { kind: "task.cancel" }, signer: "human" }, session);
    await f.daemon.tick();
    await publication;
    expect(f.publisher.publish).toHaveBeenCalledWith(expect.any(Function), { signer: session });
    f.resolveIntent.mockReturnValueOnce(null);
    await expect(f.daemon.handlers().publish({ intent: {}, signer: "daemon" })).rejects.toThrow(
      "Invalid intent",
    );
  });
  it("streams local log tails through the IPC writer and describes remote logs", async () => {
    const f = await fixture();
    const write = vi.fn(async () => true);
    expect(
      await f.daemon.handlers().logsTail({ agent: "mac.coding", tail_bytes: 4 }, write),
    ).toHaveProperty("local", true);
    expect(write).toHaveBeenCalledWith({ text: "log\n" });
    expect(write).toHaveBeenCalledWith({ text: "", eof: true });
    expect(await f.daemon.handlers().logsTail({ agent: "vps.coding" }, write)).toHaveProperty(
      "local",
      false,
    );
  });
  it("registers a stopped slot again using IPC's role_dir parameter", async () => {
    const f = await fixture();
    await f.daemon.handlers().agentStop({ role_dir: ".skep-sim/role" });
    const started = f.daemon.handlers().agentStart({ role_dir: ".skep-sim/role" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.daemon.tick();
    expect(await started).toEqual({ agent: "mac.coding" });
    const publish = f.publisher.publish.mock.calls[0]?.[0];
    expect(publish?.(f.state)).toMatchObject({ type: "agent.registered", actor: "mac.coding" });
  });
  it("holds the device lock across sync/IPC lifecycle and drains shutdown publications", async () => {
    const lock = { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const ipc = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const f = await fixture({ lock, ipc });
    f.duties.stop.mockImplementation(async () => {
      await f.daemon.publish(intent);
    });
    await f.daemon.start();
    await f.daemon.stop();
    expect(lock.acquire).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(ipc.start).toHaveBeenCalledOnce();
    expect(ipc.stop).toHaveBeenCalledOnce();
    expect(f.publisher.publish).toHaveBeenCalled();
    expect(f.hint).toHaveBeenCalled();
  });
  it("orders suspend, sync, alarms/stale cleanup, duties, heartbeat and queue drain (F13)", async () => {
    const f = await fixture();
    const result = f.daemon.publish(intent);
    await f.daemon.tick();
    expect((await result).status).toBe("accepted");
    expect(f.order).toEqual(["suspend", "sync", "stale", "duties", "heartbeat", "publish", "hint"]);
    expect(f.hint).toHaveBeenCalledWith({
      v: 1,
      kind: "tip",
      topic: f.state.blackboard_id,
      ref: "main",
      sha: f.state.tip,
    });
  });
  it("publishes hints only for accepted events and preserves human signing options", async () => {
    const f = await fixture();
    const signer = { principal: "human", sign: vi.fn() };
    f.publisher.publish.mockResolvedValueOnce({
      status: "rejected" as "accepted",
      eventId: fakeEventId(601),
      seq: 1,
    });
    const publication = f.daemon.publish(intent, { signer, eventId: fakeEventId(1) });
    await f.daemon.tick();
    await publication;
    expect(f.hint).not.toHaveBeenCalled();
    expect(f.publisher.publish).toHaveBeenCalledWith(expect.any(Function), {
      signer,
      eventId: fakeEventId(1),
    });
  });
  it("keeps accepted publication successful if a hint transport fails (D18)", async () => {
    const f = await fixture();
    f.hint.mockRejectedValueOnce(new Error("Hint relay unavailable"));
    const publication = f.daemon.publish(intent);
    await f.daemon.tick();
    expect((await publication).status).toBe("accepted");
    expect(f.daemon.status().alarms.some((alarm) => alarm.kind === "hint_failed")).toBe(true);
  });
  it("detects suspend, resets liveness and freshly reverifies before duties (F16)", async () => {
    const f = await fixture();
    f.clock.suspend();
    await f.time.advance(60_000);
    f.clock.resume();
    await f.daemon.tick();
    expect(f.reset).toHaveBeenCalledOnce();
    expect(f.sync.observeNow).toHaveBeenCalledTimes(2);
    expect(f.duties.setPaused).toHaveBeenCalledWith(true);
    expect(f.duties.setPaused).toHaveBeenLastCalledWith(false);
    expect(f.suspend.paused).toBe(false);
  });
  it("enters read-only mode after a reducer RangeError and alarms once (G16)", async () => {
    const f = await fixture();
    f.sync.observeNow.mockRejectedValue(new RangeError("Reducer version needs upgrade"));
    const publication = f.daemon.publish(intent).catch((error: unknown) => error);
    await f.daemon.tick();
    await f.daemon.tick();
    expect(await publication).toBeInstanceOf(Error);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.duties.tick).not.toHaveBeenCalled();
    expect(f.daemon.status().read_only).toBe(true);
    expect(f.daemon.status().alarms).toHaveLength(1);
    expect(f.notify).toHaveBeenCalledOnce();
    await expect(f.daemon.publish(intent)).rejects.toThrow("read-only");
  });
  it("recognizes reducer errors wrapped in sync alarms", async () => {
    const f = await fixture();
    f.alarm({
      kind: "sync_failed",
      error: new SyncError("Replay failed", { cause: new RangeError("Unsupported reducer") }),
    });
    expect(f.daemon.status().read_only).toBe(true);
    await f.daemon.tick();
    expect(f.duties.tick).not.toHaveBeenCalled();
  });
  it("reports duplicate boots in status and notifications (G16)", async () => {
    const f = await fixture();
    vi.spyOn(f.liveness, "alarms").mockReturnValue([
      { kind: "duplicate-daemon", agent: "vps.coding", bootId: "b_1111", supersededBy: "b_2222" },
    ]);
    await f.daemon.tick();
    expect(f.daemon.status().alarms.some((alarm) => alarm.kind === "duplicate-daemon")).toBe(true);
    expect(f.notify).toHaveBeenCalled();
  });
  it("sends heartbeats only when due", async () => {
    const f = await fixture();
    await f.daemon.tick();
    await f.time.advance(20_000);
    await f.daemon.tick();
    expect(f.beat).toHaveBeenCalledOnce();
    await f.time.advance(280_000);
    await f.daemon.tick();
    expect(f.beat).toHaveBeenCalledTimes(2);
  });
  it("serializes concurrent ticks", async () => {
    const f = await fixture();
    await Promise.all([f.daemon.tick(), f.daemon.tick()]);
    expect(f.order).toEqual([
      "suspend",
      "sync",
      "stale",
      "duties",
      "heartbeat",
      "suspend",
      "sync",
      "stale",
      "duties",
    ]);
  });
  it("exposes local IPC status/log/doctor and rejects remote log access", async () => {
    const f = await fixture();
    const handlers = f.daemon.handlers();
    expect(await handlers.status()).toHaveProperty("hints.connected", false);
    expect(await handlers.log({})).toEqual([]);
    expect(await handlers.doctor()).toHaveProperty("ok", true);
    expect(await handlers.ping()).toHaveProperty("reducer_version", 1);
    expect(await handlers.logsTail({ agent: "vps.coding" })).toHaveProperty("local", false);
    await expect(handlers.publish({ intent: {}, signer: "human" })).rejects.toThrow(
      "signing callback",
    );
    await handlers.agentStop({ role_dir: ".skep-sim/role" });
    expect(f.duties.stopSlot).toHaveBeenCalledWith("mac.coding");
  });
});
