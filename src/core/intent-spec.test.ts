import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { IntentSpecSchema } from "../ipc/protocol.js";
import { intentFromSpec } from "./intent-spec.js";
import { submitIntent } from "./intents.js";
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
        submit: "device",
        owner: VPS,
      },
      { kind: "work.submit", task: T1, item: "W1", method: "none", skip: false },
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
    expect([...seen].sort()).toEqual(
      IntentSpecSchema.options.map((option) => option.shape.kind.value).sort(),
    );
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

describe("submission spec mapping", () => {
  it.each([
    { method: "none", state: "local" },
    { method: "push", state: "pushed" },
    { method: "pr", state: "opened", pr_url: "https://example.invalid/pull/1", pr_number: 1 },
    { method: "mr", state: "opened", pr_url: "https://example.invalid/merge/1", pr_number: 1 },
    { method: "none", state: "skipped" },
  ] as const)("maps $method / $state using the current delivery", (submission) => {
    const current = state();
    const task = current.tasks[T1];
    if (!task) throw new Error("Missing task");
    task.status = "delivered";
    task.items.W1 = {
      id: "W1",
      title: "Example",
      assignee: VPS,
      depends_on: [],
      requires: [],
      status: "delivered",
      lease: null,
      delivered: {
        epoch: 3,
        branch: "example",
        head_sha: "a".repeat(40),
        submit: { method: "ask", state: "pending" },
        check_runs: [],
        seq: 9,
      },
      merged: null,
      failure: null,
      last_checkpoint: null,
      attempts_this_plan: 1,
    };
    const { state: submissionState, ...fields } = submission;
    const spec = {
      kind: "work.submit",
      task: T1,
      item: "W1",
      ...fields,
      skip: submissionState === "skipped",
    };
    const intent = intentFromSpec(spec, ctx);
    expect(intent?.(current)).toEqual(
      submitIntent({ task_id: T1, item: "W1", actor: "human", ...submission })(current),
    );
    expect(intent?.(current)).toMatchObject({ payload: { epoch: 3, head_sha: "a".repeat(40) } });
    task.items.W1.submission = {
      item: "W1",
      epoch: 3,
      head_sha: "a".repeat(40),
      method: "none",
      state: "local",
      seq: 10,
    };
    expect(intent?.(current)).toBeNull();
  });
});
