import { describe, expect, it } from "vitest";
import {
  describeOutcome,
  groupBrief,
  itemsProgress,
  MAX_QUESTION_ROUNDS,
  type OrchestrationEvent,
  type OrchestrationItem,
  type OrchestrationState,
  reduceOrchestration,
  startOrchestration,
} from "./reducer.js";
import {
  briefText,
  MAX_BRIEF_CHARS,
  MAX_INTENT_CHARS,
  MAX_TITLE_CHARS,
  parseRefineOutput,
} from "./schemas.js";

const refined = (extra: Record<string, unknown> = {}): OrchestrationEvent => ({
  type: "refined",
  output: { title: "Remember the last user", brief: "Store the last login name.", ...extra },
});

const item = (verdict: OrchestrationItem["verdict"], itemId = "I-1"): OrchestrationItem => ({
  intentId: "intent-1",
  itemId,
  verdict,
  repo: "app",
});

function run(state: OrchestrationState, ...events: OrchestrationEvent[]): OrchestrationState {
  return events.reduce(reduceOrchestration, state);
}

describe("orchestration reducer (plan §3.3)", () => {
  it("auto: refine → dispatch → await → synthesize → done", () => {
    let state = startOrchestration("O-1", "make login remember me", "auto");
    expect(state.phase).toBe("refining");
    state = run(state, refined());
    expect(state.phase).toBe("dispatching");
    expect(state.brief).toEqual({
      title: "Remember the last user",
      text: "Store the last login name.",
    });
    state = run(state, { type: "dispatched", outcomes: [{ intentId: "intent-1" }] });
    expect(state.phase).toBe("awaiting");
    state = run(state, { type: "itemsChanged", items: [item("running")] });
    expect(state.phase).toBe("awaiting");
    state = run(state, { type: "itemsChanged", items: [item("done")] });
    expect(state.phase).toBe("synthesizing");
    state = run(state, { type: "synthesized", text: "All done." });
    expect(state).toMatchObject({ phase: "done", synthesis: "All done.", raw: false });
    // A final state ignores everything, cancel included.
    expect(run(state, { type: "cancelled" })).toBe(state);
  });

  it("confirm: waits for the human, who may edit the brief or cancel", () => {
    const start = run(startOrchestration("O-1", "x", "confirm"), refined());
    expect(start.phase).toBe("confirming");
    const edited = run(start, { type: "confirmed", brief: { title: "T", text: "edited" } });
    expect(edited).toMatchObject({ phase: "dispatching", brief: { title: "T", text: "edited" } });
    expect(run(start, { type: "confirmed" }).brief?.text).toBe("Store the last login name.");
    expect(run(start, { type: "cancelled" }).phase).toBe("cancelled");
  });

  it(`asks at most ${MAX_QUESTION_ROUNDS} rounds of questions, then the brief stands`, () => {
    let state = startOrchestration("O-1", "x", "auto");
    for (let round = 1; round <= MAX_QUESTION_ROUNDS; round++) {
      state = run(state, refined({ questions: ["which page?"] }));
      expect(state).toMatchObject({ phase: "asking", questions: ["which page?"] });
      state = run(state, { type: "answered", text: `answer ${round}` });
      expect(state.phase).toBe("refining");
    }
    state = run(state, refined({ questions: ["still unsure?"] }));
    expect(state.phase).toBe("dispatching");
    expect(state.answers).toEqual(["answer 1", "answer 2"]);
  });

  it("refine and dispatch failures end the request with their stage", () => {
    const refine = run(startOrchestration("O-1", "x", "auto"), {
      type: "refineFailed",
      cause: "bad json",
    });
    expect(refine).toMatchObject({
      phase: "failed",
      failure: { stage: "refine", cause: "bad json" },
    });
    const dispatch = run(startOrchestration("O-1", "x", "auto"), refined(), {
      type: "dispatchFailed",
      cause: "no_match",
    });
    expect(dispatch.failure).toEqual({ stage: "dispatch", cause: "no_match" });
  });

  it("a pending item stalls; /summarize synthesizes with what exists; it can still settle", () => {
    const awaiting = run(startOrchestration("O-1", "x", "auto"), refined(), {
      type: "dispatched",
      outcomes: [{ intentId: "intent-1" }],
    });
    const stalled = run(awaiting, {
      type: "itemsChanged",
      items: [item("done"), item("pending", "I-2")],
    });
    expect(stalled.phase).toBe("stalled");
    expect(run(stalled, { type: "summarizeNow" }).phase).toBe("synthesizing");
    expect(
      run(stalled, { type: "itemsChanged", items: [item("done"), item("done", "I-2")] }).phase,
    ).toBe("synthesizing");
    // Nothing to summarize before any item exists.
    expect(run(awaiting, { type: "summarizeNow" }).phase).toBe("awaiting");
  });

  it("a failed synthesis still ends done, marked raw", () => {
    const state = run(
      startOrchestration("O-1", "x", "auto"),
      refined(),
      { type: "dispatched", outcomes: [{ intentId: "intent-1" }] },
      { type: "itemsChanged", items: [item("failed")] },
      { type: "synthFailed", cause: "timed out" },
    );
    expect(state).toMatchObject({ phase: "done", raw: true, synthesis: null });
    expect(state.failure).toEqual({ stage: "synthesize", cause: "timed out" });
  });

  it("is plain JSON and never mutates its input", () => {
    const start = startOrchestration("O-1", "x", "auto");
    const frozen = JSON.stringify(start);
    const next = run(start, refined(), {
      type: "dispatched",
      outcomes: [{ intentId: "intent-1" }],
    });
    expect(JSON.stringify(start)).toBe(frozen);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });

  it("classifies item progress", () => {
    expect(itemsProgress([])).toBe("running");
    expect(itemsProgress([item("done"), item("running")])).toBe("running");
    expect(itemsProgress([item("done"), item("declined"), item("submit-failed")])).toBe("settled");
    expect(itemsProgress([item("failed"), item("pending")])).toBe("stalled");
  });
});

describe("per-repo groups (ORCH-7)", () => {
  const targets = [
    { repo: "web", brief: "Remember the name in the login form." },
    { repo: "api", title: "Return the last user", brief: "Add GET /last-user." },
    { repo: "docs" },
  ];

  it("a refine without targets has one group the route places", () => {
    const state = run(startOrchestration("O-1", "x", "auto"), refined());
    expect(state.groups).toEqual([
      { repo: null, title: null, brief: null, intentId: null, error: null },
    ]);
    expect(groupBrief(state, state.groups[0] as never)).toEqual(state.brief);
  });

  it("targets become one group each; a target without its own text uses the top-level one", () => {
    const state = run(startOrchestration("O-1", "x", "auto"), refined({ targets }));
    expect(state.groups.map((group) => group.repo)).toEqual(["web", "api", "docs"]);
    const [web, api, docs] = state.groups.map((group) => groupBrief(state, group));
    expect(web).toEqual({
      title: "Remember the last user",
      text: "Remember the name in the login form.",
    });
    expect(api).toEqual({ title: "Return the last user", text: "Add GET /last-user." });
    expect(docs).toEqual(state.brief);
  });

  it("a partial dispatch awaits what was sent and keeps why the rest was not", () => {
    const state = run(startOrchestration("O-1", "x", "auto"), refined({ targets }), {
      type: "dispatched",
      outcomes: [{ intentId: "N-1" }, { error: "no peer works on repo api" }, { intentId: "N-2" }],
    });
    expect(state.phase).toBe("awaiting");
    expect(state.intentIds).toEqual(["N-1", "N-2"]);
    expect(state.groups.map((group) => [group.intentId, group.error])).toEqual([
      ["N-1", null],
      [null, "no peer works on repo api"],
      ["N-2", null],
    ]);
  });

  it("nothing sent fails the dispatch with every group's cause", () => {
    const state = run(startOrchestration("O-1", "x", "auto"), refined({ targets }), {
      type: "dispatched",
      outcomes: [{ error: "e1" }, { error: "e2" }],
    });
    expect(state.phase).toBe("failed");
    expect(state.failure).toEqual({
      stage: "dispatch",
      cause: "web: e1; api: e2; docs: not sent",
    });
  });

  it("describeOutcome names every item and every brief that was not sent", () => {
    const state = run(
      startOrchestration("O-1", "x", "auto"),
      refined({ targets }),
      {
        type: "dispatched",
        outcomes: [{ intentId: "N-1" }, { intentId: "N-2" }, { error: "no peer for docs" }],
      },
      {
        type: "itemsChanged",
        items: [
          { intentId: "N-1", itemId: "I-1", verdict: "done", repo: "web", device: "mac" },
          { intentId: "N-2", itemId: "I-2", verdict: "failed", repo: "api", device: "vps" },
          { intentId: "N-2", itemId: "I-3", verdict: "pending", repo: "api", peerId: "peer-3" },
        ],
      },
    );
    expect(describeOutcome(state)).toBe(
      "1 of 3 done: I-1 web on mac; 1 failed: I-2 api on vps; " +
        "1 waiting for a human: I-3 api on peer-3; not sent: docs (no peer for docs)",
    );
  });

  it("describeOutcome names an intent no peer took yet", () => {
    const state = run(startOrchestration("O-1", "x", "auto"), refined({ targets }), {
      type: "dispatched",
      outcomes: [{ intentId: "N-1" }, { intentId: "N-2" }, { intentId: "N-3" }],
    });
    expect(describeOutcome(state)).toBe(
      "no item yet: web (intent N-1), api (intent N-2), docs (intent N-3)",
    );
  });
});

describe("RefineOutputSchema", () => {
  it("takes the last fenced json block", () => {
    const reply =
      'thinking...\n```json\n{"title":"old","brief":"old"}\n```\nbetter:\n```json\n' +
      '{"title":"Add /healthz","brief":"Add a health endpoint.","questions":["which port?"]}\n```\n';
    expect(parseRefineOutput(reply)).toEqual({
      ok: true,
      output: {
        title: "Add /healthz",
        brief: "Add a health endpoint.",
        questions: ["which port?"],
      },
    });
  });

  it("accepts a bare JSON object and rejects unknown keys, empty fields and oversize text", () => {
    expect(parseRefineOutput('{"title":"t","brief":"b"}').ok).toBe(true);
    expect(parseRefineOutput('```json\n{"title":"t","brief":"b","run":"rm"}\n```')).toMatchObject({
      ok: false,
    });
    expect(parseRefineOutput('```json\n{"title":"","brief":"b"}\n```').ok).toBe(false);
    const long = JSON.stringify({ title: "t", brief: "b".repeat(MAX_BRIEF_CHARS + 1) });
    expect(parseRefineOutput(long).ok).toBe(false);
    expect(parseRefineOutput("no json here")).toEqual({
      ok: false,
      reason: expect.stringContaining("no fenced ```json block"),
    });
  });

  it("fits the longest title and brief into one v2 intent (locked §9.12: about 7800)", () => {
    expect(MAX_BRIEF_CHARS).toBe(7_798);
    const title = "t".repeat(MAX_TITLE_CHARS);
    const brief = "b".repeat(MAX_BRIEF_CHARS);
    expect(parseRefineOutput(JSON.stringify({ title, brief })).ok).toBe(true);
    expect(briefText(title, brief)).toHaveLength(MAX_INTENT_CHARS);
  });

  it("takes per-repo targets, each repo once", () => {
    const ok = { title: "t", brief: "b", targets: [{ repo: "web" }, { repo: "api", brief: "x" }] };
    expect(parseRefineOutput(JSON.stringify(ok)).ok).toBe(true);
    const twice = { title: "t", brief: "b", targets: [{ repo: "web" }, { repo: "web" }] };
    expect(parseRefineOutput(JSON.stringify(twice))).toEqual({
      ok: false,
      reason: expect.stringContaining("each repo may appear in targets once"),
    });
    const extra = { title: "t", brief: "b", targets: [{ repo: "web", peer: "peer-2" }] };
    expect(parseRefineOutput(JSON.stringify(extra)).ok).toBe(false);
  });

  it("puts the title line first on the wire", () => {
    expect(briefText("Title", "Body")).toBe("Title\n\nBody");
  });
});
