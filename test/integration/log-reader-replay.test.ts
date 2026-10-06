import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../../src/core/log.js";
import { applyEntry, replay } from "../../src/core/reducer/replay.js";
import type { State } from "../../src/core/reducer/state.js";
import { serializeEvent } from "../../src/core/schemas/events.js";
import { readLog } from "../../src/git/log-reader.js";
import { NodeGitRunner } from "../../src/git/runner.js";
import { SshKeySigner } from "../../src/git/signer.js";
import {
  commitFile,
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../helpers/git-fixture.js";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  T2,
  taskCreated,
  VPS,
} from "../helpers/log-builder.js";

function withoutLogShas(state: State): unknown {
  const { tip: _tip, genesis_sha: _genesis, outcomes, ...rest } = state;
  return { ...rest, outcomes: outcomes.map(({ sha: _sha, ...outcome }) => outcome) };
}

function entryAt(entries: LogEntry[], seq: number): LogEntry {
  const entry = entries[seq];
  if (!entry) throw new Error(`Missing fixture entry ${seq}`);
  return entry;
}

describe("real Git log and pure builder replay parity (AC 4)", () => {
  const git = new NodeGitRunner();
  const repoUrl = "https://example.invalid/code.git";
  let root: string;
  let repo: string;
  let trustPath: string;
  let signers: Record<string, SshKeySigner>;

  beforeAll(async () => {
    root = await tempDir("log-reader-replay-");
    vi.stubEnv("HOME", root);
    repo = join(root, "repo");
    await initRepo(repo);
    const keys = [
      { name: "human", principal: "human" },
      { name: "mac", principal: "daemon:mac" },
      { name: "vps", principal: "daemon:vps" },
    ];
    const trusted = [];
    signers = {};
    for (const { name, principal } of keys) {
      const key = await generateKey(root, name);
      signers[principal] = new SshKeySigner({ principal, keyPath: key.privPath });
      trusted.push({ principal, pubLine: key.pubLine });
    }
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, trusted);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("replays matching accepted, rejected, duplicate and invalid events, incrementally and fully", async () => {
    const builder = new LogBuilder();
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    builder.append({
      type: "task.created",
      actor: "human",
      payload: taskCreated({ repo: repoUrl }),
    });
    builder.append({
      type: "owner.transferred",
      actor: "human",
      payload: { new_owner: MAC },
      pre: { task_rev: 1, owner_gen: 1 },
    });
    const plan = samplePlan({ base: { repo: repoUrl, branch: "main", commit: "a".repeat(40) } });
    const proposal = planProposed(plan);
    builder.append({
      type: "plan.proposed",
      actor: VPS,
      payload: proposal,
      pre: { task_rev: 2, owner_gen: 2 },
    });
    builder.append({
      type: "plan.proposed",
      actor: MAC,
      payload: proposal,
      pre: { task_rev: 2, owner_gen: 2 },
    });
    const approval = builder.append({
      type: "plan.approved",
      actor: "human",
      payload: { plan_version: 1, plan_hash: proposal.plan_hash },
      pre: { task_rev: 3, plan_version: 1, plan_hash: proposal.plan_hash },
    });
    // PRD §8.2: duplicates still need an added path; reuse the ID under another task directory.
    const duplicate: Record<string, unknown> = { ...approval, task_id: T2 };
    builder.appendRaw(duplicate);
    builder.append(
      {
        type: "task.cancelled",
        actor: "human",
        payload: { reason: "Stale observation" },
        pre: { task_rev: 4 },
      },
      { observedTip: entryAt(builder.entries, 0).sha },
    );
    builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Stale revision" },
      pre: { task_rev: 99 },
    });
    builder.append(
      { type: "agent.registered", actor: MAC, payload: agentRegistered() },
      {
        mutate: (entry) => {
          entry.signature = { status: "missing" };
        },
      },
    );
    const invalid = builder.event({
      type: "agent.registered",
      actor: MAC,
      payload: agentRegistered(),
    });
    const malformed: Record<string, unknown> = { ...invalid, unexpected: true };
    builder.appendRaw(malformed);
    builder.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Requested cancellation" },
      pre: { task_rev: 4 },
    });

    const originalGenesis = entryAt(builder.entries, 0);
    const genesisContent = originalGenesis.added["skep.json"];
    const human = signers.human;
    if (genesisContent == null || !human) throw new Error("Missing genesis fixture");
    let parent = await commitFile(git, repo, "skep.json", genesisContent, human);
    const actualShas = new Map([[originalGenesis.sha, parent]]);
    for (const original of builder.entries.slice(1)) {
      const path = original.changes[0]?.path;
      if (!path) throw new Error("Missing event path");
      const content = original.added[path];
      if (content == null) throw new Error("Missing event content");
      const event = JSON.parse(content);
      event.observed_tip = actualShas.get(event.observed_tip) ?? event.observed_tip;
      const signer =
        original.signature.status === "good" ? signers[original.signature.principal] : undefined;
      if (original.signature.status === "good" && !signer) throw new Error("Missing signer");
      parent = await commitFile(git, repo, path, serializeEvent(event), signer);
      actualShas.set(original.sha, parent);
    }

    const entries = await readLog(git, repo, trustPath);
    const actual = replay(entries);
    const expected = replay(builder.entries);
    expect(actual.tasks).toEqual(expected.tasks);
    expect(actual.agents).toEqual(expected.agents);
    expect(withoutLogShas(actual)).toEqual(withoutLogShas(expected));
    expect(actual.outcomes.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["accepted", null],
      ["accepted", null],
      ["accepted", null],
      ["accepted", null],
      ["rejected", "unauthorized"],
      ["accepted", null],
      ["accepted", null],
      ["duplicate", null],
      ["rejected", "stale_tip"],
      ["rejected", "pre_mismatch"],
      ["invalid", "unsigned"],
      ["invalid", "schema_invalid"],
      ["accepted", null],
    ]);
    expect(actual.tasks[T1]?.status).toBe("cancelled");
    for (const seq of [0, 4, 7, 11, entries.length - 1]) {
      const tip = entryAt(entries, seq);
      const suffix = await readLog(git, repo, trustPath, { from: { sha: tip.sha, seq } });
      expect(suffix).toEqual(entries.slice(seq + 1));
      expect(suffix.reduce(applyEntry, replay(entries.slice(0, seq + 1)))).toEqual(actual);
    }
  });
});
