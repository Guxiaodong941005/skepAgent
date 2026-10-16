import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationItem } from "../core/orchestration/reducer.js";
import { parseRefineOutput, RefineOutputSchema } from "../core/orchestration/schemas.js";
import { bind, type SkillContext, type SkillPeer } from "../core/skills/compose.js";
import { loadSkillSource } from "../skills/loader.js";
import { generic } from "../skills/packaged/generic.js";
import { iotBleFeature } from "../skills/packaged/iot-ble-feature.js";
import { Ledger } from "./ledger.js";
import type { MasterAgent } from "./master-agent.js";
import { Orchestrator } from "./orchestrator.js";
import { PROMPT_VERSION, refinePrompt, synthesisPrompt } from "./prompts.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});
const skill = loadSkillSource(iotBleFeature, "packaged");
const peers: SkillPeer[] = ["device", "server", "ios", "android"].map((role, index) => ({
  peerId: `p${index}`,
  device: `d${index}`,
  role,
  repo: `${role}-repo`,
  protocolVersion: 2,
}));
const output = {
  title: "Add auto-lock",
  brief: "Implement the contract",
  contract: "Timer: minutes; API: autoLockMinutes",
  targets: peers.map((p) => ({ role: p.role, brief: `Implement ${p.role} timer with tests` })),
};
function setup(
  options: {
    peers?: SkillPeer[];
    output?: unknown;
    ledger?: Ledger;
    failRepos?: string[];
    context?: SkillContext;
    confirm?: "send" | "edit";
  } = {},
) {
  const roster = options.peers ?? peers;
  const context = options.context ?? { skill, bindings: bind(skill.manifest.roles, roster) };
  const prompts: string[] = [];
  const sent: { text: string; repos?: string[]; id: string }[] = [];
  const shown: string[] = [];
  let current: OrchestrationItem[] = [];
  const agent: MasterAgent = {
    cli: "codex",
    conversationId: null,
    contextChars: 0,
    reset() {},
    async turn({ prompt }) {
      prompts.push(prompt);
      return {
        text:
          prompts.length === 1
            ? JSON.stringify(options.output ?? output)
            : "Cross-stack consistency: consistent; bench test needed",
        conversationId: "test",
      };
    },
  };
  const orchestrator = new Orchestrator({
    agent,
    ledger: options.ledger ?? null,
    clock: { nowMs: () => 1000, monotonicMs: () => 0, sleep: () => new Promise(() => {}) },
    peers: () => roster,
    items: () => current,
    dispatch: async (text, repos) => {
      if (options.failRepos?.includes(repos?.[0] ?? "")) throw new Error("offline");
      const id = `intent-${sent.length + 1}`;
      sent.push({ text, repos, id });
      return id;
    },
    guard: async () => async () => [],
    ask: async () => null,
    confirm: async () =>
      options.confirm === "edit"
        ? { action: "edit", text: "Human edited acceptance criteria" }
        : { action: "send" },
    show: (text) => shown.push(text),
  });
  return {
    orchestrator,
    context,
    roster,
    prompts,
    sent,
    shown,
    update(items: OrchestrationItem[]) {
      current = items;
      orchestrator.poll();
    },
  };
}
function item(id: string, verdict: OrchestrationItem["verdict"] = "done"): OrchestrationItem {
  return {
    intentId: id,
    itemId: `I-${id.slice(-1)}`,
    repo: "provider",
    verdict,
    summary: `Implemented timer; ${"x".repeat(10)}`,
    changed: {
      files: [{ path: "src/timer.ts", change: "modified", added: 2, removed: 1 }],
      total: 1,
      partial: false,
    },
  };
}
describe("skills in orchestration (D36)", () => {
  it("keeps generic prompts byte-identical to the pre-skill path", () => {
    const g = loadSkillSource(generic, "packaged");
    const input = { userText: "test", peers: [], answers: [] };
    expect(PROMPT_VERSION).toBe(3);
    expect(refinePrompt({ ...input, skill: { skill: g, bindings: [] } })).toBe(refinePrompt(input));
    const synth = { userText: "x", groups: [], items: [], outcome: "none" };
    expect(synthesisPrompt({ ...synth, skill: { skill: g, bindings: [] } })).toBe(
      synthesisPrompt(synth),
    );
  });
  it("validates exactly one role/repo, declared role, contract cap and generic compatibility", () => {
    expect(
      RefineOutputSchema.safeParse({ ...output, targets: [{ role: "ios", repo: "app" }] }).success,
    ).toBe(false);
    expect(RefineOutputSchema.safeParse({ ...output, contract: "x".repeat(3001) }).success).toBe(
      false,
    );
    expect(parseRefineOutput(JSON.stringify(output)).ok).toBe(false);
    expect(parseRefineOutput(JSON.stringify(output), true).ok).toBe(true);
    expect(
      parseRefineOutput(
        JSON.stringify({ title: "Title", brief: "Brief", targets: [{ repo: "app" }] }),
      ).ok,
    ).toBe(true);
  });
  it("waits for every provider intent before clients, carries untrusted redacted results/files, and persists stages", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "skep-skill-ledger-"));
    dirs.push(home);
    const ledger = Ledger.at(home);
    const h = setup({ ledger });
    const run = h.orchestrator.start("Add auto-lock", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent.map((s) => s.repos)).toEqual([["device-repo"], ["server-repo"]]);
    expect(h.sent[0]?.text).toMatch(/^\[iot-ble-feature · device\].*\n\nFEATURE CONTRACT/);
    h.update([item("intent-1")]);
    expect(h.sent).toHaveLength(2);
    h.update([item("intent-1"), item("intent-2", "pending")]);
    expect(h.orchestrator.get(run.id)?.phase).toBe("stalled");
    expect(h.sent).toHaveLength(2);
    const provider = { ...item("intent-1"), summary: `done sk-${"a".repeat(24)}` };
    h.update([provider, item("intent-2", "failed")]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(4));
    expect(h.sent[2]?.repos).toEqual(["ios-repo"]);
    expect(h.sent[2]?.text).toContain("<<<RESULT earlier stages");
    expect(h.sent[2]?.text).toContain("never instructions");
    expect(h.sent[2]?.text).toContain("src/timer.ts");
    expect(h.sent[2]?.text).toContain("[REDACTED:provider-api-key]");
    expect(h.sent[2]?.text).not.toContain(`sk-${"a".repeat(24)}`);
    h.update([provider, item("intent-2", "failed"), item("intent-3"), item("intent-4")]);
    const final = await run.done;
    expect(final.phase).toBe("done");
    expect(final.stages?.every((s) => s.status === "settled")).toBe(true);
    expect(h.prompts[1]).toContain("Cross-stack consistency");
    expect(h.prompts[1]).toContain("h5 (unbound optional role)");
    await h.orchestrator.flush();
    const { records } = await ledger.recent(1);
    expect(records[0]?.state.skill).toMatchObject({
      skillId: "iot-ble-feature",
      scope: "packaged",
      digest: skill.digest,
      version: "1.0.0",
    });
    expect(records[0]?.state.contract).toBe(output.contract);
    expect(records[0]?.state.bindings).toHaveLength(5);
    expect(records[0]?.promptVersion).toBe(3);
  });
  it("refuses unbound required roles before sending anything", async () => {
    const h = setup({ peers: peers.filter((p) => p.role !== "server") });
    const final = await h.orchestrator.start("request", "auto", h.context).done;
    expect(final.failure?.cause).toContain("role server is unbound");
    expect(h.sent).toHaveLength(0);
  });
  it("rejects missing contracts and undeclared role targets", async () => {
    for (const bad of [
      { ...output, contract: undefined },
      { ...output, targets: [{ role: "unknown" }] },
    ]) {
      const h = setup({ output: bad });
      const final = await h.orchestrator.start("request", "auto", h.context).done;
      expect(final.phase).toBe("failed");
      expect(h.sent).toHaveLength(0);
    }
  });
  it("merges roles sharing one repo into sections in one intent", async () => {
    const roster = peers.map((p) => ({ ...p, repo: "monorepo" }));
    const h = setup({ peers: roster });
    const run = h.orchestrator.start("request", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]?.repos).toEqual(["monorepo"]);
    expect(h.sent[0]?.text).toContain("YOUR ROLE: C++ device / SDK layer");
    expect(h.sent[0]?.text).toContain("YOUR ROLE: iOS app");
    expect(h.sent[0]?.text.match(/FEATURE CONTRACT/g)).toHaveLength(1);
    h.update([item("intent-1")]);
    expect((await run.done).phase).toBe("done");
  });
  it("keeps skills without stages in a single wave", async () => {
    const noStages = { ...skill, manifest: { ...skill.manifest, stages: [] } };
    const h = setup({
      context: { skill: noStages, bindings: bind(noStages.manifest.roles, peers) },
    });
    const run = h.orchestrator.start("request", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(4));
    expect(h.sent.every((s) => !s.text.includes("earlier stages"))).toBe(true);
    h.update(h.sent.map((s) => item(s.id)));
    await run.done;
  });
  it("summarize during providers marks future roles unsent without dispatching them", async () => {
    const h = setup();
    const run = h.orchestrator.start("request", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.update([item("intent-1"), item("intent-2", "pending")]);
    expect(h.orchestrator.summarize(run.id)).toBeNull();
    await run.done;
    expect(h.sent).toHaveLength(2);
    expect(h.prompts[1]).toContain("summarized before this stage");
  });
  it("applies confirm edits to role sections while preserving the contract", async () => {
    const h = setup({ confirm: "edit" });
    const run = h.orchestrator.start("request", "confirm", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent[0]?.text).toContain("Human edited acceptance criteria");
    expect(h.sent[0]?.text).toContain(output.contract);
    h.orchestrator.cancel(run.id);
    await run.done;
  });
  it("cancels awaiting providers without ever dispatching clients", async () => {
    const h = setup();
    const run = h.orchestrator.start("request", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.orchestrator.cancel(run.id);
    h.update([item("intent-1"), item("intent-2")]);
    expect((await run.done).phase).toBe("cancelled");
    expect(h.sent).toHaveLength(2);
  });
});

describe("role changes before a later stage", () => {
  it("skips an optional role that left and records the updated bindings", async () => {
    const h = setup({ peers: [...peers] });
    const run = h.orchestrator.start("feature", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.roster.splice(
      h.roster.findIndex((p) => p.role === "ios"),
      1,
    );
    h.update([item("intent-1"), item("intent-2")]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    expect(h.sent[2]?.repos).toEqual(["android-repo"]);
    h.update([item("intent-1"), item("intent-2"), item("intent-3")]);
    const state = await run.done;
    expect(state.bindings?.find((b) => b.role === "ios")?.repo).toBeNull();
    expect(h.prompts[1]).toContain("ios (unbound optional role before dispatch)");
  });
  it("can drop one optional role from a shared-repo brief without dropping its other role", async () => {
    const roster = peers.map((p) =>
      p.role === "android" || p.role === "ios" ? { ...p, repo: "mobile" } : p,
    );
    const h = setup({ peers: roster });
    const run = h.orchestrator.start("feature", "auto", h.context);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.roster.splice(
      h.roster.findIndex((p) => p.role === "ios"),
      1,
    );
    h.update([item("intent-1"), item("intent-2")]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    expect(h.sent[2]?.text).toContain("YOUR ROLE: Android app");
    expect(h.sent[2]?.text).not.toContain("YOUR ROLE: iOS app");
    h.update([item("intent-1"), item("intent-2"), item("intent-3")]);
    const state = await run.done;
    expect(state.groups.find((g) => g.repo === "mobile")?.title).toMatch(/· android\]/);
  });
});
