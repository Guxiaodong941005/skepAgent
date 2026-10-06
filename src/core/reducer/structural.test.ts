import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  fakeEventId,
  fakeSha,
  LogBuilder,
  T1,
  T2,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import { eventPath } from "../ids.js";
import type { LogEntry } from "../log.js";
import { MAX_EVENT_BYTES } from "../schemas/common.js";
import { applyEntry, replay } from "./replay.js";
import type { InvalidReason } from "./state.js";
import { checkStructure } from "./structural.js";

function rewrite(entry: LogEntry, transform: (value: Record<string, unknown>) => void): void {
  const path = entry.changes[0]?.path ?? "";
  const value = JSON.parse(entry.added[path] ?? "{}") as Record<string, unknown>;
  transform(value);
  entry.added[path] = JSON.stringify(value);
}

const violations: [string, InvalidReason, (entry: LogEntry) => void][] = [
  [
    "merge commit",
    "not_linear",
    (e) => {
      e.parents.push(fakeSha("other-parent"));
    },
  ],
  [
    "orphan commit",
    "not_linear",
    (e) => {
      e.parents = [];
    },
  ],
  [
    "wrong parent",
    "parent_mismatch",
    (e) => {
      e.parents = [fakeSha("wrong-parent")];
    },
  ],
  [
    "unsigned",
    "unsigned",
    (e) => {
      e.signature = { status: "missing" };
    },
  ],
  [
    "bad signature",
    "bad_signature",
    (e) => {
      e.signature = { status: "bad", detail: "tampered" };
    },
  ],
  [
    "unknown key",
    "unknown_signer",
    (e) => {
      e.signature = { status: "unknown_key", detail: "untrusted" };
    },
  ],
  [
    "unparseable signer",
    "unknown_signer",
    (e) => {
      e.signature = { status: "good", principal: "daemon:INVALID" };
    },
  ],
  [
    "two files added",
    "not_single_add",
    (e) => {
      e.changes.push({ status: "A", path: "another.json" });
    },
  ],
  [
    "no files added",
    "not_single_add",
    (e) => {
      e.changes = [];
    },
  ],
  ...(["M", "D", "R", "C", "T", "other"] as const).map(
    (status): [string, InvalidReason, (entry: LogEntry) => void] => [
      `${status} change`,
      "not_single_add",
      (e) => {
        e.changes = [{ status, path: e.changes[0]?.path ?? "" }];
      },
    ],
  ),
  [
    "bad path",
    "bad_event_path",
    (e) => {
      e.changes = [{ status: "A", path: "events/../event.json" }];
    },
  ],
  [
    "null content",
    "unreadable_event",
    (e) => {
      e.added[e.changes[0]?.path ?? ""] = null;
    },
  ],
  [
    "missing content",
    "unreadable_event",
    (e) => {
      e.added = {};
    },
  ],
  [
    "invalid JSON",
    "schema_invalid",
    (e) => {
      e.added[e.changes[0]?.path ?? ""] = "{";
    },
  ],
  [
    "oversized content",
    "schema_invalid",
    (e) => {
      e.added[e.changes[0]?.path ?? ""] = " ".repeat(MAX_EVENT_BYTES + 1);
    },
  ],
  [
    "unknown envelope key",
    "schema_invalid",
    (e) =>
      rewrite(e, (value) => {
        value.extra = true;
      }),
  ],
  [
    "unknown payload key",
    "schema_invalid",
    (e) =>
      rewrite(e, (value) => {
        value.payload = { reason: "Cancel", extra: true };
      }),
  ],
  [
    "wrong language",
    "schema_invalid",
    (e) =>
      rewrite(e, (value) => {
        value.lang = "de";
      }),
  ],
  [
    "missing required pre",
    "schema_invalid",
    (e) =>
      rewrite(e, (value) => {
        value.pre = {};
      }),
  ],
  [
    "task path mismatch",
    "path_mismatch",
    (e) =>
      rewrite(e, (value) => {
        value.task_id = T2;
      }),
  ],
  [
    "event path mismatch",
    "path_mismatch",
    (e) =>
      rewrite(e, (value) => {
        value.event_id = fakeEventId();
      }),
  ],
];

describe("structural validation", () => {
  it.each(violations)("records %s as a no-op invalid entry (%s)", (_name, reason, mutate) => {
    const builder = new LogBuilder();
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
    const before = replay(builder.entries);
    builder.append(
      {
        type: "task.cancelled",
        actor: "human",
        payload: { reason: "Cancel" },
        pre: { task_rev: 1 },
      },
      { mutate },
    );
    const entry = builder.entries.at(-1) as LogEntry;
    expect(checkStructure(entry, before.tip)).toMatchObject({ ok: false, reason });
    const after = applyEntry(before, entry);
    expect(after).toEqual({
      ...before,
      tip: entry.sha,
      seq: entry.seq,
      outcomes: [
        ...before.outcomes,
        expect.objectContaining({
          seq: entry.seq,
          sha: entry.sha,
          outcome: "invalid",
          reason,
          event_id: null,
          type: null,
          task_id: null,
          actor: null,
        }),
      ],
    });
    expect(before.seq).toBe(2);
  });

  it("accepts both cluster and task paths and resolves the principal", () => {
    const builder = new LogBuilder();
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    expect(
      checkStructure(builder.entries[1] as LogEntry, builder.entries[0]?.sha ?? ""),
    ).toMatchObject({
      ok: true,
      principal: { kind: "daemon", device: "vps" },
      event: { task_id: null },
    });
    builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
    expect(
      checkStructure(builder.entries[2] as LogEntry, builder.entries[1]?.sha ?? ""),
    ).toMatchObject({ ok: true, principal: { kind: "human" }, event: { task_id: T1 } });
  });

  it("enforces check precedence even when later checks also fail", () => {
    const builder = new LogBuilder();
    const event = builder.append({
      type: "agent.registered",
      actor: VPS,
      payload: agentRegistered(),
    });
    const entry = structuredClone(builder.entries[1]) as LogEntry;
    entry.parents = [];
    entry.signature = { status: "missing" };
    entry.changes = [{ status: "M", path: "wrong" }];
    expect(checkStructure(entry, builder.entries[0]?.sha ?? "")).toMatchObject({
      reason: "not_linear",
    });
    entry.parents = [fakeSha("wrong")];
    expect(checkStructure(entry, builder.entries[0]?.sha ?? "")).toMatchObject({
      reason: "parent_mismatch",
    });
    entry.parents = [builder.entries[0]?.sha ?? ""];
    expect(checkStructure(entry, entry.parents[0] ?? "")).toMatchObject({ reason: "unsigned" });
    entry.signature = { status: "good", principal: "human" };
    expect(checkStructure(entry, entry.parents[0] ?? "")).toMatchObject({
      reason: "not_single_add",
    });
    entry.changes = [{ status: "A", path: "wrong" }];
    expect(checkStructure(entry, entry.parents[0] ?? "")).toMatchObject({
      reason: "bad_event_path",
    });
    entry.changes = [{ status: "A", path: eventPath(null, event.event_id) }];
    entry.added = {};
    expect(checkStructure(entry, entry.parents[0] ?? "")).toMatchObject({
      reason: "unreadable_event",
    });
  });
});
