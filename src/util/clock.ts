import { setTimeout as delay } from "node:timers/promises";

/**
 * Injected time source. Production code never calls Date.now()/performance.now()/setTimeout
 * directly; it takes a Clock so the simulation harness can drive time (PRD §16.3).
 *
 * - `monotonicMs()` never goes backwards and (on Linux/macOS) does not advance while the machine
 *   is suspended. Used for TTLs, timeouts, backoff.
 * - `nowMs()` is wall-clock time. Used only for display (`created_at`, `sent_at`) and for suspend
 *   detection (wall time advancing much faster than monotonic time, PRD §9.5).
 */
export interface Clock {
  monotonicMs(): number;
  nowMs(): number;
  /** Resolves after `ms` of monotonic time; rejects with AbortError if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  nowMs: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
};

/** ISO-8601 UTC without milliseconds, e.g. `2026-10-05T09:14:03Z`. */
export function isoUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
