import { describe, expect, it } from "vitest";
import {
  itemsProgress,
  MAX_QUESTION_ROUNDS,
  type OrchestrationEvent,
  type OrchestrationItem,
  type OrchestrationState,
  reduceOrchestration,
  startOrchestration,
} from "./reducer.js";
import { briefText, parseRefineOutput } from "./schemas.js";

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
    state = run(state, { type: "dispatched", intentIds: ["intent-1"] });
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
      intentIds: ["intent-1"],
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
      { type: "dispatched", intentIds: ["intent-1"] },
      { type: "itemsChanged", items: [item("failed")] },
      { type: "synthFailed", cause: "timed out" },
    );
    expect(state).toMatchObject({ phase: "done", raw: true, synthesis: null });
    expect(state.failure).toEqual({ stage: "synthesize", cause: "timed out" });
  });

  it("is plain JSON and never mutates its input", () => {
    const start = startOrchestration("O-1", "x", "auto");
    const frozen = JSON.stringify(start);
    const next = run(start, refined(), { type: "dispatched", intentIds: ["intent-1"] });
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
    const long = JSON.stringify({ title: "t", brief: "b".repeat(3_801) });
    expect(parseRefineOutput(long).ok).toBe(false);
    expect(parseRefineOutput("no json here")).toEqual({
      ok: false,
      reason: expect.stringContaining("no fenced ```json block"),
    });
  });

  it("puts the title line first on the wire", () => {
    expect(briefText("Title", "Body")).toBe("Title\n\nBody");
  });
});
