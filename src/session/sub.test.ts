import { describe, expect, it } from "vitest";
import { DATALIST_CAP, DatalistEntriesSchema } from "./messages.js";
import { prepareDatalist } from "./sub.js";

describe("sub datalists", () => {
  it("truncates 40 KiB to the serialized byte cap", () => {
    const input = Array.from({ length: 40 }, (_, index) => ({
      kind: "path" as const,
      path: `src/${index}`,
      detail: "x".repeat(1024),
    }));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(40 * 1024);
    const output = prepareDatalist(input);
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output.entries))).toBeLessThanOrEqual(DATALIST_CAP);
    expect(DatalistEntriesSchema.safeParse(output.entries).success).toBe(true);
    expect(DatalistEntriesSchema.safeParse(input).success).toBe(false);
  });

  it("redacts path/detail and counts UTF-8 bytes and JSON escapes after redaction", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(prepareDatalist([{ kind: "path", path: token, detail: token }])).toEqual({
      entries: [
        { kind: "path", path: "[REDACTED:github-token]", detail: "[REDACTED:github-token]" },
      ],
      truncated: false,
    });
    const output = prepareDatalist(
      Array.from({ length: 100 }, () => ({
        kind: "signature",
        path: "🌍".repeat(500),
        detail: "\u0000".repeat(1024),
      })),
    );
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output.entries))).toBeLessThanOrEqual(DATALIST_CAP);
  });

  it("caps entry count and rejects malformed collector output", () => {
    expect(
      prepareDatalist(Array.from({ length: 2001 }, () => ({ kind: "path", path: "x" }))).truncated,
    ).toBe(true);
    expect(() => prepareDatalist([{ kind: "path", path: "" }])).toThrow();
    expect(prepareDatalist([])).toEqual({ entries: [], truncated: false });
  });
});
