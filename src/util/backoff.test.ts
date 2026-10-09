import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff.js";
import type { RandomSource } from "./random.js";

/** Deterministic RandomSource: successive calls return incrementing bytes (no sim/rng). */
function source(seed: number): RandomSource {
  let n = seed & 0xff;
  return {
    bytes(count: number): Uint8Array {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = n;
        n = (n + 17) & 0xff;
      }
      return out;
    },
  };
}

describe("backoffDelay", () => {
  it("keeps the first attempt within ±25 % of 500 ms", () => {
    for (let seed = 0; seed < 200; seed++) {
      const delay = backoffDelay(0, source(seed));
      expect(delay).toBeGreaterThanOrEqual(500 * 0.75);
      expect(delay).toBeLessThanOrEqual(500 * 1.25);
    }
  });

  it("grows in expectation with the attempt and never exceeds maxMs", () => {
    const attempts = [0, 1, 2, 3, 4, 8, 16];
    for (const attempt of attempts) {
      for (let seed = 0; seed < 50; seed++) {
        const delay = backoffDelay(attempt, source(seed));
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(30_000);
      }
    }
    const early = Array.from({ length: 100 }, (_, seed) => backoffDelay(0, source(seed)));
    const late = Array.from({ length: 100 }, (_, seed) => backoffDelay(4, source(seed)));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(late)).toBeGreaterThan(mean(early));
  });

  it("rejects a negative or non-integer attempt", () => {
    expect(() => backoffDelay(-1, source(0))).toThrow(RangeError);
    expect(() => backoffDelay(1.5, source(0))).toThrow(RangeError);
  });
});
