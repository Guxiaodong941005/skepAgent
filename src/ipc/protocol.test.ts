import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  errorFrame,
  INTENT_KINDS,
  IntentSpecSchema,
  IPC_METHODS,
  IPC_VERSION,
  MAX_FRAME_BYTES,
  parseParams,
  parseRequest,
  resultFrame,
} from "./protocol.js";

const SIGNATURE = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHTlVUVVJF
-----END SSH SIGNATURE-----
`;

describe("frame decoding", () => {
  it("accepts every method and a sign result", () => {
    for (const method of IPC_METHODS) {
      const decoded = decodeFrame({ v: 1, id: "c1", method, params: {} }, "client");
      expect(decoded.error).toBeUndefined();
      expect(decoded.frame).toMatchObject({ method });
    }
    const reply = decodeFrame(
      { v: 1, id: "c1", sign_result: { req: "s1", signature: SIGNATURE } },
      "client",
    );
    expect(reply.frame).toMatchObject({ sign_result: { req: "s1" } });
  });

  it("accepts the four daemon frame shapes", () => {
    const frames = [
      resultFrame("c1", { pong: true }),
      errorFrame("c1", "unavailable", "daemon is read-only"),
      { v: 1, id: "c1", sign_request: { req: "s1", payload_b64: "YQ==", principal: "human" } },
      { v: 1, id: "c1", stream: { agent: "mac.coding", text: "line\n" } },
    ];
    for (const frame of frames) {
      expect(decodeFrame(frame, "server").error).toBeUndefined();
    }
  });

  it("rejects unknown keys, missing fields and non-objects as bad_frame", () => {
    const rejected = [
      { v: 1, id: "c1", method: "ping", params: {}, extra: true },
      { v: 1, id: "c1" },
      { v: 1, id: "c1", method: "nope" },
      { v: 1, id: "", method: "ping" },
      null,
      "ping",
      [],
    ];
    for (const value of rejected) {
      const decoded = decodeFrame(value, "client");
      expect(decoded.frame).toBeUndefined();
      expect(decoded.error?.code).toBe("bad_frame");
    }
  });

  it("reports protocol_version for any other v, before other fields are judged", () => {
    for (const value of [
      { v: 2, id: "c1", method: "ping" },
      { v: 0, id: "c1", method: "not-a-method", junk: true },
      { v: "1", id: "c1", method: "ping" },
    ]) {
      const decoded = decodeFrame(value, "client");
      expect(decoded.error?.code).toBe("protocol_version");
      expect(decoded.id).toBe("c1");
    }
    // A frame with no version at all is simply malformed, not a negotiation failure.
    expect(decodeFrame({ id: "c1", method: "ping" }, "client").error?.code).toBe("bad_frame");
  });

  it("round-trips a frame through encode", () => {
    const frame = { v: IPC_VERSION as 1, id: "c1", method: "ping" as const, params: {} };
    expect(encodeFrame(frame).endsWith("\n")).toBe(true);
    const decoded = decodeFrame(JSON.parse(encodeFrame(frame).trimEnd()), "client");
    expect(decoded.frame).toEqual(frame);
  });
});

describe("params", () => {
  it("validates publish and rejects a daemon signer with a human-only shape", () => {
    const ok = parseParams("publish", {
      intent: { kind: "lease.revoke", task: "T-20261005-7f3a", item: "W1", epoch: 1 },
      signer: "human",
    });
    expect(ok.ok).toBe(true);

    const bad = parseParams("publish", { intent: { kind: "lease.revoke" }, signer: "daemon" });
    expect(bad.ok).toBe(false);

    const request = parseRequest({
      v: 1,
      id: "c1",
      method: "logs.tail",
      params: { agent: "mac.coding", follow: true },
    });
    expect(request.ok && request.request.params).toEqual({ agent: "mac.coding", follow: true });
  });

  it("rejects unknown param keys", () => {
    const parsed = parseParams("ping", { extra: 1 });
    expect(parsed.ok).toBe(false);
  });
});

describe("IntentSpec", () => {
  it("covers every CLI write kind and rejects unknown kinds and keys", () => {
    const specs = [
      { kind: "task.create", title: "Toggle", body: "Add a toggle.", repo: "app", mode: "solo" },
      { kind: "task.cancel", task: "T-20261005-7f3a", reason: "no longer needed" },
      { kind: "plan.approve", task: "T-20261005-7f3a" },
      { kind: "plan.reject", task: "T-20261005-7f3a", note: "needs work" },
      {
        kind: "lease.revoke",
        task: "T-20261005-7f3a",
        item: "W2",
        epoch: 3,
        reason: "holder is stale",
      },
      { kind: "decide", task: "T-20261005-7f3a", decision: "replan" },
      {
        kind: "decide",
        task: "T-20261005-7f3a",
        decision: "reassign_owner",
        new_owner: "vps.coding",
      },
      { kind: "replan.request", task: "T-20261005-7f3a", reason: "approach is wrong" },
    ];
    const seen = new Set<string>();
    for (const spec of specs) {
      expect(IntentSpecSchema.parse(spec)).toEqual(spec);
      seen.add(spec.kind);
    }
    expect([...seen].sort()).toEqual([...INTENT_KINDS].sort());

    expect(IntentSpecSchema.safeParse({ kind: "task.pause" }).success).toBe(false);
    expect(
      IntentSpecSchema.safeParse({
        kind: "task.cancel",
        task: "T-20261005-7f3a",
        reason: "x",
        extra: 1,
      }).success,
    ).toBe(false);
    // new_owner belongs only to reassign_owner.
    expect(
      IntentSpecSchema.safeParse({
        kind: "decide",
        task: "T-20261005-7f3a",
        decision: "cancel",
        new_owner: "vps.coding",
      }).success,
    ).toBe(false);
  });
});

describe("limits", () => {
  it("caps a frame at 1 MiB", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });
});
