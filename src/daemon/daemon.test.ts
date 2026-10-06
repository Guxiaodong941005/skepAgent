import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  fakeEventId,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { LivenessTracker } from "../blackboard/liveness.js";
import type { PublishResult } from "../blackboard/publisher.js";
import { type SyncAlarm, SyncError } from "../blackboard/sync.js";
import { decodeStatus } from "../cli/commands/status.js";
import { renderStatus, revokeSuggestions } from "../cli/render-status.js";
import { workBranch } from "../core/ids.js";
import { draft, type Intent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import { statusView } from "../core/reducer/views.js";
import type { Heartbeat } from "../core/schemas/heartbeat.js";
import { Redactor } from "../exec/redact.js";
import type { Signer } from "../git/signer.js";
import { connectIpc, type IpcClient } from "../ipc/client.js";
import { SuspendDetector } from "../lease/suspend.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { NullHintChannel } from "../transport/null-hint.js";
import { Daemon, type DaemonDependencies } from "./daemon.js";
import { IpcServer } from "./ipc-server.js";
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
  it.each(["handler", "Unix socket"])(
    "decodes %s status with late/stale revoke guidance",
    async (transport) => {
      const f = await fixture();
      const log = new LogBuilder();
      for (const actor of [MAC, VPS])
        log.append({ type: "agent.registered", actor, payload: agentRegistered() });
      log.append({ type: "task.created", actor: "human", payload: taskCreated() });
      const proposal = planProposed(samplePlan());
      log.append({
        type: "plan.proposed",
        actor: VPS,
        payload: proposal,
        pre: { task_rev: 1, owner_gen: 1 },
      });
      log.append({
        type: "plan.approved",
        actor: "human",
        payload: { plan_version: 1, plan_hash: proposal.plan_hash },
        pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
      });
      log.append({
        type: "lease.claimed",
        actor: VPS,
        payload: { item: "W1", attempt_id: "att_status", branch: workBranch(T1, "W1", 1) },
        pre: {
          task_rev: 3,
          plan_version: 1,
          plan_hash: proposal.plan_hash,
          item: "W1",
          expected_epoch: 0,
        },
      });
      Object.assign(f.state, replay(log.entries));
      expect(f.state.tasks[T1]?.items.W1?.lease?.holder).toBe(VPS);
      const hb: Heartbeat = {
        schema: "skep.hb/v1",
        agent: VPS,
        boot_id: "b_0601",
        n: 1,
        state: "running",
        task_id: T1,
        item: "W1",
        epoch: 1,
        observed_main: f.state.tip,
        runtime: "native",
        sent_at: "2026-10-06T00:00:00Z",
      };
      f.liveness.observe(VPS, "a".repeat(40), hb);
      f.liveness.observe(VPS, "a".repeat(40), hb);
      f.daemon.alarm(new Error("Example alert"), "example");
      await f.time.advance(240_000);
      const root = await mkdtemp(join(process.cwd(), ".skep-status-test-"));
      const socketPath = join(root, "skepd.sock");
      const server = new IpcServer({
        socketPath,
        handlers: f.daemon.handlers(),
        redactor: new Redactor(),
      });
      let client: IpcClient | undefined;
      try {
        if (transport === "Unix socket") {
          await server.start();
          client = await connectIpc(socketPath);
        }
        const callStatus = async () =>
          client
            ? client.call("status", {})
            : { ok: true as const, result: await f.daemon.handlers().status({}) };
        const response = await callStatus();
        expect(response).toEqual({
          ok: true,
          result: {
            view: statusView(f.state),
            extras: {
              liveness: [
                { agent: MAC, cls: "unknown", sinceChangeMs: 0, intervalMs: 300_000 },
                { agent: VPS, cls: "unknown", sinceChangeMs: 240_000, intervalMs: 60_000 },
              ],
              freshness: { checkedAgoMs: 240_000, invalidCount: 0, reducerVersion: 1 },
              hints: f.hints.health(),
              alarms: [{ kind: "example", detail: "Example alert" }],
              readOnly: false,
            },
          },
        });
        const late = decodeStatus(response);
        expect(late.extras.nowMonoMs - (late.extras.freshness.checkedAtMonoMs ?? 0)).toBe(240_000);
        const lateText = renderStatus(late.view, late.extras);
        expect(lateText).toContain("checked 4m ago");
        expect(lateText).toContain("late (hb 4m)");
        expect(lateText).toContain("! example: Example alert");
        expect(revokeSuggestions(late.view, late.extras)).toEqual([]);
        await f.time.advance(120_000);
        const stale = decodeStatus(await callStatus());
        const command = `skep lease revoke ${T1} W1 --epoch 1`;
        expect(stale.extras.liveness.find((agent) => agent.agent === VPS)?.cls).toBe("stale");
        expect(renderStatus(stale.view, stale.extras)).toContain("stale (hb 6m)");
        expect(renderStatus(stale.view, stale.extras)).toContain(command);
        expect(revokeSuggestions(stale.view, stale.extras)).toEqual([
          { task: T1, item: "W1", epoch: 1, holder: VPS, label: "stale", command },
        ]);
      } finally {
        client?.close();
        await server.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
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
    expect(f.daemon.status().extras.alarms.some((alarm) => alarm.kind === "hint_failed")).toBe(
      true,
    );
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
    expect(f.daemon.status().extras.readOnly).toBe(true);
    expect(f.daemon.status().extras.alarms).toHaveLength(1);
    expect(f.notify).toHaveBeenCalledOnce();
    await expect(f.daemon.publish(intent)).rejects.toThrow("read-only");
  });
  it("recognizes reducer errors wrapped in sync alarms", async () => {
    const f = await fixture();
    f.alarm({
      kind: "sync_failed",
      error: new SyncError("Replay failed", { cause: new RangeError("Unsupported reducer") }),
    });
    expect(f.daemon.status().extras.readOnly).toBe(true);
    await f.daemon.tick();
    expect(f.duties.tick).not.toHaveBeenCalled();
  });
  it("reports duplicate boots in status and notifications (G16)", async () => {
    const f = await fixture();
    vi.spyOn(f.liveness, "alarms").mockReturnValue([
      { kind: "duplicate-daemon", agent: "vps.coding", bootId: "b_1111", supersededBy: "b_2222" },
    ]);
    await f.daemon.tick();
    expect(f.daemon.status().extras.alarms.some((alarm) => alarm.kind === "duplicate-daemon")).toBe(
      true,
    );
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
    expect(await handlers.status()).toHaveProperty("extras.hints.connected", false);
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
