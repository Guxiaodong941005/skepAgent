import { describe, expect, it } from "vitest";
import { Rng, rngRandomSource } from "../sim/rng.js";
import { backoffDelay } from "./backoff.js";
import type { RandomSource } from "./random.js";

function source(seed: number): RandomSource {
  return rngRandomSource(new Rng(seed));
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
    const attempts = [0, 1, 2, 3, 4];
    const means = attempts.map((attempt) => {
      let total = 0;
      for (let seed = 0; seed < 400; seed++) total += backoffDelay(attempt, source(seed));
      return total / 400;
    });

    // Doubling each attempt until the 30 s ceiling flattens it.
    for (let i = 1; i < means.length; i++) {
      const prev = means[i - 1] ?? 0;
      const current = means[i] ?? 0;
      expect(current).toBeGreaterThan(prev);
    }
    expect(means[0]).toBeGreaterThan(490);
    expect(means[0]).toBeLessThan(510);

    let saturated = 0;
    for (let seed = 0; seed < 400; seed++) saturated += backoffDelay(20, source(seed));
    saturated /= 400;
    expect(saturated).toBeGreaterThan(28_000);
    expect(saturated).toBeLessThanOrEqual(30_000);

    for (let seed = 0; seed < 50; seed++) {
      for (const attempt of [...attempts, 20]) {
        const delay = backoffDelay(attempt, source(seed));
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(30_000);
      }
    }
  });

  it("is deterministic for a seeded source and honours overrides", () => {
    const once = Array.from({ length: 6 }, (_, attempt) => backoffDelay(attempt, source(1234)));
    const twice = Array.from({ length: 6 }, (_, attempt) => backoffDelay(attempt, source(1234)));
    expect(twice).toEqual(once);
    expect(once).not.toEqual(
      Array.from({ length: 6 }, (_, attempt) => backoffDelay(attempt, source(1235))),
    );

    const fixed = new Rng(1);
    const mid = backoffDelay(3, rngRandomSource(fixed), {
      baseMs: 100,
      factor: 3,
      jitter: 0,
      maxMs: 10_000,
    });
    expect(mid).toBe(100 * 3 ** 3);

    const capped = backoffDelay(3, rngRandomSource(new Rng(1)), {
      baseMs: 100,
      factor: 3,
      jitter: 0,
      maxMs: 1000,
    });
    expect(capped).toBe(1000);
  });

  it("rejects a negative attempt", () => {
    expect(() => backoffDelay(-1, source(1))).toThrow(RangeError);
    expect(() => backoffDelay(1.5, source(1))).toThrow(RangeError);
  });
});
