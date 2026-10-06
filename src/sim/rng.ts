import type { RandomSource } from "../util/random.js";

/**
 * Seeded PRNG for the simulation harness (ARCHITECTURE §13.1). sfc32 seeded by a cyrb128 hash of
 * the seed string, so a run is fully determined by its seed and forks are independent streams.
 */

/** cyrb128: 128-bit hash of a string, used only to expand a seed into sfc32's four state words. */
function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = Math.imul(seed.charCodeAt(i), 3432918353);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h2 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h3 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h4 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32: small, fast, chaotic 32-bit generator. Returns a float in [0, 1). */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Warm-up discards the first outputs, which for sfc32 still correlate with the seed words. */
const WARMUP_DRAWS = 12;

function generatorFor(seed: number | string): () => number {
  const [a, b, c, d] = cyrb128(String(seed));
  const next = sfc32(a, b, c, d);
  for (let i = 0; i < WARMUP_DRAWS; i++) next();
  return next;
}

export class Rng {
  /** Kept so a fork depends only on (seed, label), never on how far the parent has been drawn. */
  private readonly seed: number | string;
  private readonly nextFloat: () => number;

  constructor(seed: number | string) {
    this.seed = seed;
    this.nextFloat = generatorFor(seed);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextFloat();
  }

  /** Uniform integer in [min, maxInclusive]. */
  int(min: number, maxInclusive: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(maxInclusive) || maxInclusive < min) {
      throw new RangeError(
        `Rng.int expects integers with min <= maxInclusive, got ${min}..${maxInclusive}`,
      );
    }
    const span = maxInclusive - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }

  /** True with probability p (clamped to [0, 1]). */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) {
      throw new RangeError("Rng.pick requires a non-empty array");
    }
    const index = this.int(0, xs.length - 1);
    const value = xs[index];
    if (value === undefined) {
      throw new RangeError(`Rng.pick index ${index} out of range`);
    }
    return value;
  }

  /** Fisher–Yates permutation. Returns a new array; the input is not mutated. */
  shuffle<T>(xs: readonly T[]): T[] {
    const out = xs.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /** `n` uniformly random bytes. */
  bytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`Rng.bytes expects a non-negative integer, got ${n}`);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int(0, 255);
    return out;
  }

  /**
   * Independent stream derived only from this generator's seed and `label`. How many values the
   * parent has already drawn does not matter, and drawing from the fork never advances the parent.
   */
  fork(label: string): Rng {
    return new Rng(`${String(this.seed)}\u0000${label}`);
  }
}

/** Adapts an {@link Rng} to the injected {@link RandomSource} so production code can be replayed. */
export function rngRandomSource(rng: Rng): RandomSource {
  return { bytes: (n) => rng.bytes(n) };
}
