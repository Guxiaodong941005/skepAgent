import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { INTENT_KINDS, IntentSpecSchema } from "../ipc/protocol.js";
import { intentFromSpec } from "./intent-spec.js";
import { replay } from "./reducer/replay.js";
import type { State } from "./reducer/state.js";

const ctx = { rng: { bytes: () => new Uint8Array([0xab, 0xcd]) }, nowMs: 1_759_622_400_000 };

function state(): State {
  const log = new LogBuilder();
  log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  log.append({ type: "task.created", actor: "human", payload: taskCreated() });
  return replay(log.entries);
}

describe("intentFromSpec", () => {
  it("agrees with the socket schema on every CLI write kind", () => {
    // The two schemas are defined apart so core does not import ipc (ARCHITECTURE §2); this is
    // what keeps a frame the socket accepts buildable by the pure mapping.
    const specs = [
      {
        kind: "task.create",
        title: "Add a toggle",
        body: "Add a dark mode toggle.",
        repo: "app",
        mode: "team",
        owner: VPS,
      },
      { kind: "task.cancel", task: T1, reason: "no longer needed" },
      { kind: "plan.approve", task: T1, note: "ship it" },
      { kind: "plan.reject", task: T1 },
      { kind: "lease.revoke", task: T1, item: "W1", epoch: 2, reason: "stale" },
      { kind: "decide", task: T1, decision: "reassign_owner", new_owner: MAC },
      { kind: "replan.request", task: T1, reason: "the approach fails" },
    ];
    const seen = new Set<string>();
    for (const spec of specs) {
      // The socket schema and the mapping's schema are the same object (re-exported).
      expect(IntentSpecSchema.parse(spec)).toEqual(spec);
      expect(intentFromSpec(spec, ctx)).not.toBeNull();
      seen.add(spec.kind);
    }
    expect([...seen].sort()).toEqual([...INTENT_KINDS].sort());
  });

  it("mints one task id from the supplied clock and randomness", () => {
    const spec = {
      kind: "task.create",
      title: "Add a toggle",
      body: "Add a dark mode toggle.",
      repo: "app",
      mode: "solo",
      owner: VPS,
    };
    const first = intentFromSpec(spec, ctx)?.(state());
    const second = intentFromSpec(spec, ctx)?.(state());
    expect(first?.task_id).toBe("T-20251005-abcd");
    expect(second?.task_id).toBe(first?.task_id);
    expect(first?.payload).toMatchObject({ owner: VPS, plan_approval: "human" });
  });

  it("returns null for a spec the schema rejects, and an intent that drops on a bad state", () => {
    expect(intentFromSpec({ kind: "task.pause" }, ctx)).toBeNull();
    expect(
      intentFromSpec({ kind: "decide", task: T1, decision: "reassign_owner" }, ctx),
    ).toBeNull();
    const cancel = intentFromSpec({ kind: "task.cancel", task: T1, reason: "stop" }, ctx);
    expect(cancel?.(replay(new LogBuilder().entries))).toBeNull();
  });

  it("rejects unknown keys, since a spec is strict", () => {
    expect(
      intentFromSpec({ kind: "task.cancel", task: T1, reason: "stop", extra: true }, ctx),
    ).toBeNull();
  });
});
