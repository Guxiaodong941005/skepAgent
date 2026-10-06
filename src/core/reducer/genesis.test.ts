import { describe, expect, it } from "vitest";
import { fakeSha, genesisDoc, LogBuilder } from "../../../test/helpers/log-builder.js";
import type { LogEntry } from "../log.js";
import { GenesisError, genesisState } from "./genesis.js";
import { replay } from "./replay.js";

function root(): LogEntry {
  return structuredClone(new LogBuilder().entries[0]) as LogEntry;
}

describe("genesisState", () => {
  it("creates plain JSON state and ignores other genesis files", () => {
    const entry = root();
    entry.changes.push({ status: "A", path: "policy/allowed_signers.txt" });
    const state = genesisState(entry);
    expect(state).toEqual({
      reducer_version: 1,
      protocol_version: 1,
      blackboard_id: "bb_test0001",
      genesis_sha: entry.sha,
      tip: entry.sha,
      seq: 0,
      agents: {},
      tasks: {},
      seen_event_ids: {},
      outcomes: [],
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  const invalid: [string, (entry: LogEntry) => void][] = [
    [
      "wrong sequence",
      (e) => {
        e.seq = 1;
      },
    ],
    [
      "parent",
      (e) => {
        e.parents = [fakeSha("parent")];
      },
    ],
    [
      "unsigned",
      (e) => {
        e.signature = { status: "missing" };
      },
    ],
    [
      "bad signature",
      (e) => {
        e.signature = { status: "bad", detail: "tampered" };
      },
    ],
    [
      "unknown key",
      (e) => {
        e.signature = { status: "unknown_key", detail: "untrusted" };
      },
    ],
    [
      "daemon signer",
      (e) => {
        e.signature = { status: "good", principal: "daemon:mac" };
      },
    ],
    [
      "unrecognized principal",
      (e) => {
        e.signature = { status: "good", principal: "root" };
      },
    ],
    [
      "missing skep.json add",
      (e) => {
        e.changes = [];
      },
    ],
    [
      "modified skep.json",
      (e) => {
        e.changes = [{ status: "M", path: "skep.json" }];
      },
    ],
    [
      "unreadable skep.json",
      (e) => {
        e.added["skep.json"] = null;
      },
    ],
    [
      "missing content",
      (e) => {
        delete e.added["skep.json"];
      },
    ],
    [
      "invalid JSON",
      (e) => {
        e.added["skep.json"] = "{";
      },
    ],
    [
      "invalid schema",
      (e) => {
        e.added["skep.json"] = "{}";
      },
    ],
    [
      "unknown keys",
      (e) => {
        e.added["skep.json"] = JSON.stringify({ ...genesisDoc(), extra: true });
      },
    ],
    [
      "protocol mismatch",
      (e) => {
        e.added["skep.json"] = JSON.stringify({ ...genesisDoc(), protocol_version: 2 });
      },
    ],
    [
      "reducer mismatch",
      (e) => {
        e.added["skep.json"] = JSON.stringify({ ...genesisDoc(), reducer_version: 2 });
      },
    ],
  ];
  it.each(invalid)("throws GenesisError for %s", (_name, mutate) => {
    const entry = root();
    mutate(entry);
    expect(() => genesisState(entry)).toThrow(GenesisError);
    expect(() => replay([entry])).toThrow(/Invalid blackboard genesis:/);
  });

  it("rejects an empty log", () => {
    expect(() => replay([])).toThrow(GenesisError);
  });
});
