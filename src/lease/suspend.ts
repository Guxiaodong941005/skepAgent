import type { Clock } from "../util/clock.js";
import { isCurrentLease, type LeaseIdentity, type LeaseObserver } from "./reverify.js";

export interface SuspendNotification {
  reason: "gap" | "wake";
  gapMs: number;
  leases: LeaseIdentity[];
}

export class SuspendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuspendError";
  }
}

function leaseKey(lease: LeaseIdentity): string {
  return JSON.stringify([lease.task_id, lease.item, lease.epoch, lease.holder]);
}

/** Tick-driven by the daemon; all protocol timing uses the injected Clock (§6.3, F16). */
export class SuspendDetector {
  private wall: number;
  private mono: number;
  private held = new Map<string, LeaseIdentity>();
  private readonly unverified = new Set<string>();
  private readonly listeners = new Set<(notification: SuspendNotification) => void>();
  private generation = 0;
  private needsObservation = false;

  constructor(
    private readonly clock: Clock,
    private readonly pollMs: number,
  ) {
    if (!Number.isFinite(pollMs) || pollMs <= 0)
      throw new SuspendError("Suspend polling interval must be a positive finite number");
    this.wall = clock.nowMs();
    this.mono = clock.monotonicMs();
  }

  get paused(): boolean {
    return this.needsObservation;
  }

  /** The daemon supplies leases for its local attempts on every state change. */
  setHeldLeases(leases: readonly LeaseIdentity[]): void {
    const next = new Map(leases.map((lease) => [leaseKey(lease), { ...lease }]));
    if (next.size !== this.held.size || [...next.keys()].some((key) => !this.held.has(key))) {
      this.generation += 1;
    }
    this.held = next;
    for (const key of this.unverified) {
      if (!next.has(key)) this.unverified.delete(key);
    }
    if (this.paused) {
      for (const key of next.keys()) this.unverified.add(key);
    }
  }

  isVerified(lease: LeaseIdentity): boolean {
    const key = leaseKey(lease);
    return this.held.has(key) && !this.unverified.has(key);
  }

  onSuspend(listener: (notification: SuspendNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tick(): boolean {
    const wall = this.clock.nowMs();
    const mono = this.clock.monotonicMs();
    const gapMs = wall - this.wall - (mono - this.mono);
    this.wall = wall;
    this.mono = mono;
    // Constant inter-device clock skew cancels in the deltas (PRD §9.5).
    if (gapMs <= 2 * this.pollMs) return false;
    this.invalidate("gap", gapMs);
    return true;
  }

  notifyWake(): void {
    this.wall = this.clock.nowMs();
    this.mono = this.clock.monotonicMs();
    this.invalidate("wake", 0);
  }

  /** False keeps invocations paused; stale attempts must be journaled and removed by the daemon. */
  async verifyHeld(sync: LeaseObserver): Promise<boolean> {
    this.needsObservation = true;
    for (const key of this.held.keys()) this.unverified.add(key);
    this.generation += 1;
    const generation = this.generation;
    const leases = [...this.held.values()];
    const state = await sync.observeNow();
    // A wake, lease change, or newer verification must fence an older observation (§6.3).
    if (generation !== this.generation || !leases.every((lease) => isCurrentLease(state, lease)))
      return false;
    this.unverified.clear();
    this.needsObservation = false;
    return true;
  }

  private invalidate(reason: SuspendNotification["reason"], gapMs: number): void {
    this.generation += 1;
    this.needsObservation = true;
    for (const key of this.held.keys()) this.unverified.add(key);
    // The daemon subscribes LivenessTracker.resetAll here (ARCHITECTURE §8.2, F16).
    for (const listener of this.listeners) {
      listener({ reason, gapMs, leases: [...this.held.values()].map((lease) => ({ ...lease })) });
    }
  }
}
