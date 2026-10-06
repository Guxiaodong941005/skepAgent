import { describe, expect, it } from "vitest";
import { newEventId, uuidV4 } from "../util/random.js";
import { Rng, rngRandomSource } from "./rng.js";

function draw(seed: number | string, n: number): number[] {
  const rng = new Rng(seed);
  return Array.from({ length: n }, () => rng.next());
}

describe("Rng", () => {
  it("reproduces the first 1,000 draws from the same seed and diverges on another", () => {
    const a = draw(42, 1000);
    const b = draw(42, 1000);
    expect(a).toEqual(b);

    const other = draw(43, 1000);
    expect(other).not.toEqual(a);

    // The seed is hashed as a string, so 42 and "42" are the same stream.
    expect(draw("42", 1000)).toEqual(a);
    expect(draw("forty-two", 1000)).not.toEqual(a);

    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("forks from the seed and label alone, ignoring how far the parent was drawn", () => {
    const fresh = new Rng("scenario").fork("daemon-a");
    const parent = new Rng("scenario");
    parent.next();
    parent.next();
    parent.next();
    const afterDraws = parent.fork("daemon-a");

    const fromFresh = Array.from({ length: 100 }, () => fresh.next());
    const fromUsed = Array.from({ length: 100 }, () => afterDraws.next());
    expect(fromUsed).toEqual(fromFresh);

    const otherLabel = new Rng("scenario").fork("daemon-b");
    const fromOther = Array.from({ length: 100 }, () => otherLabel.next());
    expect(fromOther).not.toEqual(fromFresh);

    // Drawing on the fork must not advance the parent.
    const before = parent.next();
    parent.fork("unused").next();
    const replay = new Rng("scenario");
    replay.next();
    replay.next();
    replay.next();
    expect(replay.next()).toBe(before);
  });

  it("covers both bounds of int and stays inside them", () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const value = rng.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
      expect(Number.isInteger(value)).toBe(true);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([3, 4, 5]);

    expect(rng.int(9, 9)).toBe(9);
    expect(() => rng.int(2.5, 4)).toThrow(RangeError);
    expect(() => rng.int(5, 4)).toThrow(RangeError);
  });

  it("shuffles into a permutation without mutating the input", () => {
    const rng = new Rng(99);
    const input = ["a", "b", "c", "d", "e", "f"];
    const snapshot = [...input];
    const shuffled = rng.shuffle(input);

    expect(input).toEqual(snapshot);
    expect(shuffled).toHaveLength(input.length);
    expect([...shuffled].sort()).toEqual([...input].sort());
    expect(shuffled).not.toEqual(input);

    expect(rng.shuffle([])).toEqual([]);
  });

  it("returns exactly n bytes", () => {
    const rng = new Rng(1);
    expect(rng.bytes(0)).toEqual(new Uint8Array());
    const bytes = rng.bytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    expect(bytes.every((b) => b >= 0 && b <= 255)).toBe(true);
    expect(() => rng.bytes(-1)).toThrow(RangeError);
  });

  it("clamps chance to [0, 1]", () => {
    const rng = new Rng(3);
    for (let i = 0; i < 50; i++) {
      expect(new Rng(i).chance(0)).toBe(false);
      expect(new Rng(i).chance(-2)).toBe(false);
      expect(new Rng(i).chance(1)).toBe(true);
      expect(new Rng(i).chance(4)).toBe(true);
    }
    const seen = new Set<boolean>();
    for (let i = 0; i < 100; i++) seen.add(rng.chance(0.5));
    expect(seen).toEqual(new Set([false, true]));
  });

  it("picks only members and rejects an empty array", () => {
    const rng = new Rng(5);
    const options = ["x", "y", "z"] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(rng.pick(options));
    expect([...seen].sort()).toEqual(["x", "y", "z"]);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("adapts to RandomSource so id helpers are deterministic", () => {
    const first = newEventId(rngRandomSource(new Rng(42)));
    const second = newEventId(rngRandomSource(new Rng(42)));
    expect(first).toBe(second);
    expect(first).not.toBe(newEventId(rngRandomSource(new Rng(43))));

    const id = uuidV4(rngRandomSource(new Rng("uuid")));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
