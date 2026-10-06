import type { Clock } from "../util/clock.js";

/**
 * Virtual time for the simulation harness (ARCHITECTURE §13.1): one shared time base, per-daemon
 * {@link Clock} views with skew and suspend. Sleeps never use real timers — they resolve when
 * {@link VirtualTime.advance} reaches their fire time, so a scenario is deterministic.
 */

interface Timer {
  /** Virtual time the sleep was aimed at, before any later suspension postponed it. */
  at: number;
  /** Creation order; breaks ties so two timers due together always fire the same way. */
  seq: number;
  resolve: () => void;
  /** Drops the timer from the queue once it has fired or been aborted. */
  cancel: () => void;
  /** Clock that owns the timer; its suspension postpones the fire time. */
  owner?: FakeClock;
  /**
   * How much virtual time that clock had already spent suspended when the timer was scheduled.
   * Only suspension accrued afterwards postpones it.
   */
  suspensionBaseline: number;
}

export class VirtualTime {
  private time: number;
  private seq = 0;
  private readonly timers: Timer[] = [];

  constructor(startMs = 0) {
    this.time = startMs;
  }

  get now(): number {
    return this.time;
  }

  /**
   * Virtual time of the earliest timer that can actually fire, or null when nothing is runnable.
   * Timers whose clock is suspended are excluded: their fire time is not knowable until resume,
   * so reporting it would hand a scheduler a target that moves forever (review B2).
   */
  nextTimerAt(): number | null {
    const timer = this.earliest();
    return timer ? this.effectiveAt(timer, this.time) : null;
  }

  /**
   * Registers a timer due at absolute virtual time `at`. Passing the owning clock lets a later
   * suspension postpone it; without one the fire time is exactly `at`.
   *
   * Callers other than {@link FakeClock} get unsuspendable timers: with no owner there is nothing
   * to suspend, so the timer always fires at `at` regardless of any clock's state.
   */
  schedule(at: number, resolve: () => void, owner?: FakeClock): Timer {
    const timer: Timer = {
      at,
      seq: this.seq++,
      resolve,
      owner,
      suspensionBaseline: owner?.suspensionAccumulated() ?? 0,
      cancel: () => {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
      },
    };
    this.timers.push(timer);
    return timer;
  }

  /**
   * Moves virtual time forward by `ms`, firing every timer due within the window. Timers are taken
   * one at a time in (fire time, creation order) so a continuation that schedules something already
   * due still runs inside this same advance. After each timer a microtask flush lets that
   * continuation schedule before the next timer is chosen.
   *
   * Fire times are measured against the target, not the time so far: a clock suspended during this
   * very advance has its timers postponed by the suspension, which only exists once we look ahead.
   */
  async advance(ms: number): Promise<void> {
    if (ms < 0 || !Number.isFinite(ms)) {
      throw new RangeError(`VirtualTime.advance expects a non-negative finite delay, got ${ms}`);
    }
    const target = this.time + ms;
    for (;;) {
      const due = this.nextDue(target);
      if (!due) break;
      this.time = this.effectiveAt(due, target);
      due.cancel();
      due.resolve();
      await flushMicrotasks();
    }
    this.time = target;
  }

  /** Fires the single earliest pending timer, jumping time to it. False when nothing is pending. */
  async runNext(): Promise<boolean> {
    const due = this.earliest();
    if (!due) return false;
    const at = this.effectiveAt(due, Number.POSITIVE_INFINITY);
    this.time = Math.max(this.time, at);
    due.cancel();
    due.resolve();
    await flushMicrotasks();
    return true;
  }

  /** Earliest runnable timer at or before `target`, ties broken by creation order. */
  private nextDue(target: number): Timer | null {
    let best: Timer | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const timer of this.timers) {
      // A suspended clock's timer cannot fire no matter how far time moves (review B1).
      if (timer.owner?.suspended) continue;
      const at = this.effectiveAt(timer, target);
      if (at > target) continue;
      if (!best || at < bestAt || (at === bestAt && timer.seq < best.seq)) {
        best = timer;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * Earliest runnable timer, ignoring any bound. Suspended clocks are skipped: their timers become
   * eligible again on resume, once the postponed fire time is finite.
   */
  private earliest(): Timer | null {
    let best: Timer | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const timer of this.timers) {
      if (timer.owner?.suspended) continue;
      const at = this.effectiveAt(timer, this.time);
      if (!best || at < bestAt || (at === bestAt && timer.seq < best.seq)) {
        best = timer;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * Virtual fire time as seen from `viewpoint`. A suspended clock contributes the suspension it
   * will have accrued by then, so its timers stay out of reach until it resumes.
   */
  private effectiveAt(timer: Timer, viewpoint: number): number {
    const accrued = timer.owner?.suspensionAt(viewpoint) ?? 0;
    return timer.at + accrued - timer.suspensionBaseline;
  }
}

/** Several `await`s so continuations queued by a timer's resolve run before the next timer fires. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface FakeClockOptions {
  /** Wall clock reading at the virtual time this clock is constructed. Defaults to that instant. */
  wallStartMs?: number;
  /** Constant offset added to wall time, modelling clock skew between daemons. */
  skewMs?: number;
}

export class FakeClock implements Clock {
  private readonly vt: VirtualTime;
  /** Virtual time at construction: monotonic time is measured from here. */
  private readonly origin: number;
  private readonly wallStartMs: number;
  private skewMs: number;

  /** Virtual time at which the current suspension began, or null while running. */
  private suspendedAt: number | null = null;
  /** Sum of virtual time spent in completed suspensions. Monotonic time subtracts this. */
  private suspendedTotal = 0;
  /** Live timers, so an abort or a firing can drop them. */
  private readonly pending: Timer[] = [];

  constructor(vt: VirtualTime, opts: FakeClockOptions = {}) {
    this.vt = vt;
    this.origin = vt.now;
    this.wallStartMs = opts.wallStartMs ?? vt.now;
    this.skewMs = opts.skewMs ?? 0;
  }

  get suspended(): boolean {
    return this.suspendedAt !== null;
  }

  /**
   * Elapsed virtual time minus time spent suspended: monotonic time freezes across a suspend
   * while wall time keeps moving, so `Δwall − Δmono` exposes the gap (PRD §9.5).
   */
  monotonicMs(): number {
    return this.vt.now - this.origin - this.suspensionAccumulated();
  }

  /** Wall time. Keeps advancing while suspended; skew shifts it without touching monotonic time. */
  nowMs(): number {
    return this.wallStartMs + (this.vt.now - this.origin) + this.skewMs;
  }

  /**
   * Resolves after `ms` of *this clock's* monotonic time. Suspension postpones the fire time by
   * exactly the suspended duration, so the timer cannot fire until the clock is running again and
   * the remaining monotonic time has elapsed. Aborting rejects with `AbortError` and drops it.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms < 0 || !Number.isFinite(ms)) {
      return Promise.reject(
        new RangeError(`FakeClock.sleep expects a non-negative finite delay, got ${ms}`),
      );
    }
    const fireAt = this.vt.now + ms;
    let settled = false;
    let timer: Timer | null = null;
    const drop = () => {
      timer?.cancel();
      if (timer) this.forget(timer);
    };
    return new Promise<void>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) this.forget(timer);
        fn();
      };
      timer = this.vt.schedule(fireAt, () => finish(resolve), this);
      this.pending.push(timer);
      if (!signal) return;

      const onAbort = () => {
        drop();
        finish(() => reject(abortError()));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      const wrapped = timer.resolve;
      timer.resolve = () => {
        signal.removeEventListener("abort", onAbort);
        wrapped();
      };
    });
  }

  /** Freezes monotonic time. A second suspend while already suspended does nothing. */
  suspend(): void {
    if (this.suspendedAt === null) this.suspendedAt = this.vt.now;
  }

  /** Unfreezes monotonic time. Pending timers observe the gap through {@link suspensionAt}. */
  resume(): void {
    if (this.suspendedAt === null) return;
    this.suspendedTotal += this.vt.now - this.suspendedAt;
    this.suspendedAt = null;
  }

  /** Total virtual time spent suspended up to now, including an ongoing suspension. */
  suspensionAccumulated(): number {
    return this.suspensionAt(this.vt.now);
  }

  /**
   * Suspension accrued by virtual time `viewpoint`. While a suspension is in progress it grows
   * with the viewpoint, which is what lets an advance see that a timer is postponed.
   */
  suspensionAt(viewpoint: number): number {
    const ongoing = this.suspendedAt === null ? 0 : Math.max(0, viewpoint - this.suspendedAt);
    return this.suspendedTotal + ongoing;
  }

  /** Changes the wall-clock skew. Monotonic time is deliberately left untouched. */
  setSkew(ms: number): void {
    this.skewMs = ms;
  }

  private forget(timer: Timer): void {
    const index = this.pending.indexOf(timer);
    if (index >= 0) this.pending.splice(index, 1);
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
