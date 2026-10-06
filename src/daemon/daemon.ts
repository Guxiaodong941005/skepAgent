import { resolve } from "node:path";
import type { HeartbeatWriter } from "../blackboard/heartbeat.js";
import type { LivenessTracker } from "../blackboard/liveness.js";
import type { Publisher, PublishResult } from "../blackboard/publisher.js";
import type { Sync, SyncAlarm } from "../blackboard/sync.js";
import type { Intent } from "../core/intents.js";
import { GenesisError } from "../core/reducer/genesis.js";
import { REDUCER_VERSION, type State } from "../core/reducer/state.js";
import { leasesHeldBy, statusView } from "../core/reducer/views.js";
import { findSecrets, Redactor } from "../exec/redact.js";
import type { Signer } from "../git/signer.js";
import type { SuspendDetector } from "../lease/suspend.js";
import { NullHintChannel } from "../transport/null-hint.js";
import type { HintChannel } from "../transport/types.js";
import { backoffDelay } from "../util/backoff.js";
import type { Clock } from "../util/clock.js";
import type { RandomSource } from "../util/random.js";
import type { Duties } from "./duties.js";
import type { DaemonLock } from "./lock.js";
import { registrationIntent, type SlotConfig, type SlotRegistry } from "./slots.js";

export class DaemonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonError";
  }
}
export interface DaemonAlarm {
  kind: string;
  message: string;
}
export interface DaemonDependencies {
  sync: Pick<Sync, "current" | "observeNow" | "start" | "stop" | "onState" | "onAlarm"> &
    Partial<Pick<Sync, "pollNow">>;
  publisher: Pick<Publisher, "publish">;
  slots: SlotRegistry;
  duties: Pick<Duties, "tick" | "heldLeases" | "discardStale" | "setPaused" | "stop" | "stopSlot">;
  suspend: SuspendDetector;
  liveness: LivenessTracker;
  heartbeat(agent: string): Pick<HeartbeatWriter, "beat">;
  clock: Clock;
  random: RandomSource;
  hints?: HintChannel;
  lock?: Pick<DaemonLock, "acquire" | "release">;
  ipc?: { start(): Promise<void>; stop(): Promise<void> };
  resolveIntent?: (spec: unknown) => Intent | null;
  slotConfig?: (roleDir: string) => SlotConfig;
  notify?: (alarm: DaemonAlarm) => Promise<void>;
  redactor?: Pick<Redactor, "redact">;
  activeMs?: number;
  idleMs?: number;
  /** Injected local log reader; remote log access is deliberately unavailable (D18). */
  logsTail?: (agent: string, params: unknown) => Promise<{ text: string }>;
}
interface PendingPublication {
  intent: Intent;
  options?: { signer?: Signer; eventId?: string };
  resolve(result: PublishResult): void;
  reject(error: unknown): void;
}
function hasRangeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (
      error instanceof RangeError ||
      (error instanceof GenesisError && /reducer version .* unsupported/.test(error.message))
    )
      return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** One device's protocol loop; tick is also the simulator's public entry point (§11.1). */
export class Daemon {
  private readonly hints: HintChannel;
  private readonly redactor: Pick<Redactor, "redact">;
  private readonly pending: PendingPublication[] = [];
  private readonly alarms = new Map<string, DaemonAlarm>();
  private readonly beats = new Map<string, number>();
  private readonly notifications = new Set<Promise<void>>();
  private readonly unsubscribe: (() => void)[] = [];
  private tickTail: Promise<void> = Promise.resolve();
  private loop: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private sleeper: AbortController | null = null;
  private wakePending = false;
  private readOnly = false;
  private stopping = false;
  constructor(private readonly deps: DaemonDependencies) {
    this.hints = deps.hints ?? new NullHintChannel();
    this.redactor = deps.redactor ?? new Redactor();
    for (const ms of [deps.activeMs ?? 20_000, deps.idleMs ?? 90_000])
      if (!Number.isFinite(ms) || ms <= 0)
        throw new DaemonError("Daemon intervals must be positive finite numbers");
    this.unsubscribe.push(
      deps.suspend.onSuspend(() => {
        deps.liveness.resetAll();
        deps.duties.setPaused(true);
        this.wake();
      }),
      deps.sync.onState(() => this.wake()),
      deps.sync.onAlarm((alarm) => this.syncAlarm(alarm)),
    );
  }
  current(): State {
    const state = this.deps.sync.current().state;
    if (!state) throw new DaemonError("Blackboard has not been observed yet");
    return state;
  }
  wake(): void {
    this.wakePending = true;
    this.sleeper?.abort();
  }
  alarm(error: unknown, kind = "daemon_failed"): void {
    if (hasRangeError(error)) {
      this.readOnly = true;
      this.deps.duties.setPaused(true);
      kind = "reducer_version";
    }
    const message = this.redactor.redact(error instanceof Error ? error.message : String(error));
    const key = `${kind}:${message}`;
    if (this.alarms.has(key)) return;
    const alarm = { kind, message };
    this.alarms.set(key, alarm);
    if (this.deps.notify) {
      const notification = Promise.resolve()
        .then(() => this.deps.notify?.(alarm))
        .catch((cause: unknown) => {
          const failure = {
            kind: "notify_failed",
            message: this.redactor.redact(cause instanceof Error ? cause.message : String(cause)),
          };
          this.alarms.set(`notify_failed:${failure.message}`, failure);
        })
        .finally(() => this.notifications.delete(notification));
      this.notifications.add(notification);
    }
  }
  publish(intent: Intent, options?: { signer?: Signer; eventId?: string }): Promise<PublishResult> {
    if (this.readOnly)
      return Promise.reject(
        new DaemonError(
          "Daemon is read-only after a reducer version error; upgrade before publishing",
        ),
      );
    const checkedIntent: Intent = (state) => {
      const value = intent(state);
      if (value && findSecrets(JSON.stringify(value)).length > 0) {
        this.alarm(
          new DaemonError("Secret scan blocked protocol publication; inspect the local invocation"),
          "secret_detected",
        );
        throw new DaemonError("Protocol publication contains a secret pattern");
      }
      return value;
    };
    if (this.stopping)
      return this.deps.publisher.publish(checkedIntent, options).then(async (result) => {
        await this.afterPublish(result);
        return result;
      });
    const promise = new Promise<PublishResult>((resolve, reject) =>
      this.pending.push({ intent: checkedIntent, options, resolve, reject }),
    );
    this.wake();
    return promise;
  }
  tick(): Promise<void> {
    const result = this.tickTail.then(() => this.runTick());
    this.tickTail = result.catch((error: unknown) => this.alarm(error));
    return result;
  }
  private async runTick(): Promise<void> {
    this.deps.suspend.setHeldLeases(this.deps.duties.heldLeases());
    this.deps.suspend.tick();
    let state: State;
    try {
      state =
        this.deps.suspend.paused || !this.deps.sync.pollNow
          ? await this.deps.sync.observeNow()
          : await this.deps.sync.pollNow();
      if (state.reducer_version !== REDUCER_VERSION)
        throw new RangeError(`Reducer version ${state.reducer_version} requires an upgrade`);
      await this.deps.duties.discardStale(state);
      this.deps.suspend.setHeldLeases(this.deps.duties.heldLeases());
      if (this.deps.suspend.paused) {
        const verified = await this.deps.suspend.verifyHeld(this.deps.sync);
        state = this.current();
        this.deps.duties.setPaused(!verified || this.readOnly);
      }
    } catch (error) {
      this.alarm(error, "sync_failed");
      if (this.readOnly) this.rejectPending();
      return;
    }
    for (const alarm of this.deps.liveness.alarms())
      this.alarm(
        new DaemonError(
          `Competing boots for ${alarm.agent}: ${alarm.bootId} returned after ${alarm.supersededBy}`,
        ),
        alarm.kind,
      );
    if (!this.readOnly) this.deps.duties.tick(state);
    for (const slot of this.deps.slots.list()) {
      if (!slot.enabled && slot.busy.size === 0) continue;
      const held = leasesHeldBy(state, slot.agent).find((lease) => !lease.parked);
      const interval = held ? 60_000 : 300_000;
      const now = this.deps.clock.monotonicMs();
      if (this.beats.has(slot.agent) && now - (this.beats.get(slot.agent) ?? 0) < interval)
        continue;
      try {
        await this.deps.heartbeat(slot.agent).beat({
          state:
            this.readOnly || this.deps.suspend.paused
              ? "paused"
              : slot.enabled
                ? held
                  ? "running"
                  : "idle"
                : "stopping",
          task_id: held?.task_id ?? null,
          item: held?.item ?? null,
          epoch: held?.epoch ?? null,
          observed_main: state.tip,
          runtime: "native",
        });
        this.beats.set(slot.agent, now);
      } catch (error) {
        this.alarm(error, "heartbeat_failed");
      }
    }
    if (this.readOnly) this.rejectPending();
    else await this.drain();
  }
  private async drain(): Promise<void> {
    while (this.pending.length > 0 && !this.readOnly) {
      const pending = this.pending.shift();
      if (!pending) break;
      try {
        const result = await this.deps.publisher.publish(pending.intent, pending.options);
        await this.afterPublish(result);
        pending.resolve(result);
      } catch (error) {
        this.alarm(error, "publish_failed");
        pending.reject(error);
      }
    }
    if (this.readOnly) this.rejectPending();
  }
  private async afterPublish(result: PublishResult): Promise<void> {
    if (result.status === "accepted") {
      try {
        const state = this.current();
        await this.hints.publish({
          v: 1,
          kind: "tip",
          topic: state.blackboard_id,
          ref: "main",
          sha: state.tip,
        });
      } catch (error) {
        this.alarm(error, "hint_failed");
      }
      this.wake();
    } else if (result.status === "failed")
      this.alarm(new DaemonError(result.reason ?? "Publication failed"), "publish_failed");
  }
  private rejectPending(): void {
    for (const pending of this.pending.splice(0))
      pending.reject(
        new DaemonError("Publication refused: daemon is read-only; upgrade the reducer"),
      );
  }
  async start(): Promise<void> {
    if (this.controller) return;
    await this.deps.lock?.acquire();
    try {
      await this.deps.sync.start();
      await this.deps.ipc?.start();
      const controller = new AbortController();
      this.controller = controller;
      this.loop = this.run(controller);
    } catch (error) {
      await this.deps.sync.stop();
      await this.deps.lock?.release();
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    this.sleeper?.abort();
    await this.loop;
    if (this.readOnly) this.rejectPending();
    else await this.drain();
    await this.deps.duties.stop();
    await this.deps.ipc?.stop();
    await this.deps.sync.stop();
    await this.tickTail;
    await Promise.all(this.notifications);
    await this.deps.lock?.release();
    this.controller = null;
    this.loop = null;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
  private async run(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      this.wakePending = false;
      try {
        await this.tick();
      } catch (error) {
        this.alarm(error);
      }
      if (controller.signal.aborted) break;
      if (this.wakePending && !this.readOnly) continue;
      const state = this.deps.sync.current().state;
      const baseMs =
        state && this.deps.slots.isActive(state)
          ? (this.deps.activeMs ?? 20_000)
          : (this.deps.idleMs ?? 90_000);
      const sleeper = new AbortController();
      this.sleeper = sleeper;
      try {
        await this.deps.clock.sleep(
          backoffDelay(0, this.deps.random, { baseMs, maxMs: baseMs * 1.25, jitter: 0.25 }),
          sleeper.signal,
        );
      } catch (error) {
        if (!sleeper.signal.aborted) this.alarm(error);
      } finally {
        this.sleeper = null;
      }
    }
  }
  private syncAlarm(alarm: SyncAlarm): void {
    if (alarm.kind === "invalid_commit")
      this.alarm(
        new DaemonError(`Invalid commit #${alarm.outcome.seq}: ${alarm.outcome.reason}`),
        alarm.kind,
      );
    else this.alarm(alarm.error, alarm.kind);
  }
  /** SK-602 binds these handlers to its strict local IPC protocol; no network listener lives here. */
  handlers() {
    return {
      status: async (_params: Record<string, never> = {}) => this.status(),
      log: async (params: { task?: string; from_seq?: number }) =>
        this.current().outcomes.filter(
          (outcome) =>
            (!params.task || outcome.task_id === params.task) &&
            outcome.seq >= (params.from_seq ?? 0),
        ),
      publish: async (
        params: { intent: unknown; signer: "human" | "daemon" },
        session?: Signer,
      ) => {
        if (!this.deps.resolveIntent)
          throw new DaemonError("Intent resolver is unavailable; merge SK-603");
        if (params.signer === "human" && session?.principal !== "human")
          throw new DaemonError("Human publication requires the IPC signing callback");
        const intent = this.deps.resolveIntent(params.intent);
        if (!intent) throw new DaemonError("Invalid intent specification");
        return this.publish(intent, params.signer === "human" ? { signer: session } : undefined);
      },
      agentStart: async (params: { role_dir: string }) => {
        if (!this.deps.slotConfig)
          throw new DaemonError(
            "Configure the local agent user, home and PATH before starting a slot",
          );
        const slot = await this.deps.slots.start(this.deps.slotConfig(params.role_dir));
        const result = await this.publish(registrationIntent(slot));
        if (result.status !== "accepted") {
          this.deps.slots.stop(slot.agent);
          throw new DaemonError(`Slot registration failed: ${result.reason ?? result.status}`);
        }
        this.wake();
        return { agent: slot.agent };
      },
      agentStop: async (params: { role_dir: string }) => {
        const slot = this.deps.slots
          .list()
          .find((slot) => slot.roleDir === resolve(params.role_dir));
        if (!slot) throw new DaemonError("No local slot is bound to that role directory");
        this.deps.slots.stop(slot.agent);
        await this.deps.duties.stopSlot(slot.agent);
        this.wake();
        return { agent: slot.agent };
      },
      logsTail: async (
        params: { agent: string; follow?: boolean; tail_bytes?: number },
        write?: (chunk: { text: string; eof?: boolean }) => Promise<boolean>,
      ) => {
        if (!this.deps.slots.get(params.agent))
          return {
            agent: params.agent,
            local: false,
            liveness: this.deps.liveness.classify(params.agent),
            message:
              "Read the role directory journal on that device; remote logs have no transport",
          };
        if (!this.deps.logsTail) throw new DaemonError("Local log reader is unavailable");
        let previous = this.redactor.redact((await this.deps.logsTail(params.agent, params)).text);
        const tail = Buffer.from(previous)
          .subarray(-(params.tail_bytes ?? 8192))
          .toString("utf8");
        if (!write) return { agent: params.agent, local: true, text: tail };
        const send = async (text: string, eof = false): Promise<boolean> => {
          for (let offset = 0; offset < text.length; offset += 8192)
            if (!(await write({ text: text.slice(offset, offset + 8192) }))) return false;
          return write({ text: "", ...(eof ? { eof: true } : {}) });
        };
        if (!(await send(tail, !params.follow))) return { agent: params.agent, local: true };
        while (params.follow && !this.stopping) {
          await this.deps.clock.sleep(1000);
          const next = this.redactor.redact((await this.deps.logsTail(params.agent, params)).text);
          const appended = next.startsWith(previous) ? next.slice(previous.length) : next;
          previous = next;
          if (!(await send(appended))) break;
        }
        return { agent: params.agent, local: true };
      },
      doctor: async (_params: Record<string, never> = {}) => ({
        ok: !this.readOnly,
        alarms: this.status().alarms,
      }),
      ping: async (_params: Record<string, never> = {}) => ({ reducer_version: REDUCER_VERSION }),
    };
  }
  status() {
    const snapshot = this.deps.sync.current();
    const state = snapshot.state;
    return {
      ...(state ? statusView(state) : { seq: 0, tip: null, agents: [], tasks: [] }),
      reducer_version: state?.reducer_version ?? REDUCER_VERSION,
      read_only: this.readOnly,
      freshness: {
        fetched_at_mono_ms: snapshot.fetchedAtMonoMs,
        checked_age_ms:
          snapshot.fetchedAtMonoMs === null
            ? null
            : this.deps.clock.monotonicMs() - snapshot.fetchedAtMonoMs,
        invalid_count: snapshot.invalidCount,
      },
      hints: this.hints.health(),
      liveness: Object.fromEntries(
        Object.keys(state?.agents ?? {})
          .sort()
          .map((agent) => [agent, this.deps.liveness.classify(agent)]),
      ),
      alarms: [...this.alarms.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message),
      ),
    };
  }
}
