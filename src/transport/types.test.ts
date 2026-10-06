import { describe, expect, it } from "vitest";
import { type Hint, HintSchema, MAX_HINT_BYTES } from "./types.js";

const tip: Hint = {
  v: 1,
  kind: "tip",
  topic: "a".repeat(26),
  ref: "main",
  sha: "a".repeat(40),
};
const wake: Hint = { v: 1, kind: "wake", topic: "a".repeat(26), device: "mac" };

describe("HintSchema", () => {
  it.each([
    tip,
    { ...tip, sha: "b".repeat(64) },
    { ...tip, ref: "hb/mac.coding" },
    { ...tip, ref: "hb/vps.coding.2" },
    wake,
    { ...wake, device: "vps" },
  ])("accepts protocol metadata: %j", (hint) => {
    expect(HintSchema.parse(hint)).toEqual(hint);
  });

  it.each([
    null,
    [],
    JSON.stringify(tip),
    {},
    { ...tip, v: 2 },
    { ...tip, v: "1" },
    { ...tip, kind: "mailbox" },
    { ...tip, kind: "payload" },
    { ...tip, kind: "unknown" },
    { kind: "tip", topic: tip.topic, ref: "main", sha: tip.sha },
    { v: 1, kind: "tip", topic: tip.topic, ref: "main" },
    { v: 1, kind: "wake", topic: wake.topic },
    { ...tip, topic: "" },
    { ...wake, topic: "" },
    { ...tip, topic: 1 },
    { ...wake, device: "" },
    { ...wake, device: "mac.coding" },
    { ...wake, device: "MAC" },
    { ...wake, device: "mac\nvps" },
    { ...tip, sha: "a".repeat(39) },
    { ...tip, sha: "a".repeat(41) },
    { ...tip, sha: "g".repeat(40) },
    { ...tip, sha: "A".repeat(40) },
    { ...tip, sha: null },
    { ...tip, ref: "refs/heads/main" },
    { ...tip, ref: "feature/example" },
    { ...tip, ref: "hb/" },
    { ...tip, ref: "hb/mac" },
    { ...tip, ref: "hb/mac.coding/extra" },
  ])("rejects malformed or unsupported hints: %j", (hint) => {
    expect(HintSchema.safeParse(hint).success).toBe(false);
  });

  it.each(["extra", "payload", "event", "credentials", "api_key", "provider", "config", "token"])(
    "rejects the extra field %s on both variants (D17/D19)",
    (field) => {
      for (const hint of [tip, wake]) {
        expect(HintSchema.safeParse({ ...hint, [field]: "example" }).success).toBe(false);
      }
    },
  );

  it("rejects fields belonging to the other variant", () => {
    expect(HintSchema.safeParse({ ...tip, device: "mac" }).success).toBe(false);
    expect(HintSchema.safeParse({ ...wake, ref: "main", sha: tip.sha }).success).toBe(false);
  });

  it.each([tip, wake])("accepts exactly 1 KiB and rejects one extra byte: %j", (hint) => {
    const overhead = Buffer.byteLength(JSON.stringify({ ...hint, topic: "" }), "utf8");
    const atLimit = { ...hint, topic: "a".repeat(MAX_HINT_BYTES - overhead) };
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(MAX_HINT_BYTES);
    expect(HintSchema.safeParse(atLimit).success).toBe(true);

    const oversized = HintSchema.safeParse({ ...atLimit, topic: `${atLimit.topic}a` });
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.issues[0]?.message).toContain("1024 bytes");
  });

  it("counts UTF-8 bytes rather than JavaScript string length", () => {
    const hint = { ...tip, topic: "\u00e9".repeat(500) };
    expect(JSON.stringify(hint).length).toBeLessThan(MAX_HINT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(hint), "utf8")).toBeGreaterThan(MAX_HINT_BYTES);
    expect(HintSchema.safeParse(hint).success).toBe(false);
  });

  it("counts JSON escape bytes in the size limit", () => {
    const hint = { ...wake, topic: "\n".repeat(500) };
    expect(hint.topic.length).toBeLessThan(MAX_HINT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(hint), "utf8")).toBeGreaterThan(MAX_HINT_BYTES);
    expect(HintSchema.safeParse(hint).success).toBe(false);
  });
});
