import type { RandomSource } from "./random.js";

/**
 * Jittered exponential backoff (ARCHITECTURE §7.2 publisher retries, PRD §10: 0.5 s … 30 s, ±25 %).
 *
 * `attempt` is zero-based, so the first retry waits about `baseMs`. The delay is
 * `min(maxMs, baseMs · factor^attempt)` scaled by a uniform factor in `[1 − jitter, 1 + jitter]`
 * drawn from the injected source, then clamped to `[0, maxMs]`.
 */
export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs?: number;
  /** Hard ceiling, also the clamp for the jittered value. */
  maxMs?: number;
  /** Exponential growth per attempt. */
  factor?: number;
  /** Half-width of the uniform jitter band around the base delay. */
  jitter?: number;
}

const DEFAULTS = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.25 } as const;

/** Uniform float in [0, 1) from the first 48 bits of the source, so a seeded source replays. */
function unitFloat(rs: RandomSource): number {
  const bytes = rs.bytes(6);
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value / 2 ** 48;
}

export function backoffDelay(attempt: number, rs: RandomSource, opts?: BackoffOptions): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`backoffDelay expects a non-negative integer attempt, got ${attempt}`);
  }
  const baseMs = opts?.baseMs ?? DEFAULTS.baseMs;
  const maxMs = opts?.maxMs ?? DEFAULTS.maxMs;
  const factor = opts?.factor ?? DEFAULTS.factor;
  const jitter = opts?.jitter ?? DEFAULTS.jitter;

  const exponential = Math.min(maxMs, baseMs * factor ** attempt);
  const scale = 1 - jitter + unitFloat(rs) * 2 * jitter;
  const jittered = exponential * scale;
  return Math.min(maxMs, Math.max(0, jittered));
}
