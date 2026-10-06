import { describe, expect, it } from "vitest";
import { agentRegistered, fakeEventId, fakeSha, MAC, T1 } from "../../test/helpers/log-builder.js";
import { draft, EventDraftError, finalizeEvent } from "./intents.js";

const metadata = {
  event_id: fakeEventId(301),
  observed_tip: fakeSha("intent-tip"),
  created_at: "2026-10-05T00:00:00Z",
};

describe("event drafts", () => {
  it("keeps typed payloads and supplies the validated English envelope without mutation", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    const before = structuredClone(eventDraft);
    expect(finalizeEvent(eventDraft, metadata)).toEqual({
      ...eventDraft,
      ...metadata,
      schema: "skep.event/v1",
      lang: "en",
    });
    expect(eventDraft).toEqual(before);
    expect(finalizeEvent(eventDraft, metadata)).toEqual(finalizeEvent(eventDraft, metadata));
  });

  it("validates required preconditions with an actionable typed error", () => {
    const eventDraft = draft("task.cancelled", T1, "human", { reason: "Stop work" }, {});
    expect(() => finalizeEvent(eventDraft, metadata)).toThrow(EventDraftError);
    expect(() => finalizeEvent(eventDraft, metadata)).toThrow("missing required pre: task_rev");
    eventDraft.pre = { task_rev: 1 };
    expect(finalizeEvent(eventDraft, metadata).pre).toEqual({ task_rev: 1 });
  });

  it("rejects unknown envelope, payload and precondition keys", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    expect(() =>
      finalizeEvent({ ...eventDraft, extra: true } as typeof eventDraft, metadata),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        { ...eventDraft, payload: { ...eventDraft.payload, extra: true } } as typeof eventDraft,
        metadata,
      ),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        { ...eventDraft, pre: { extra: true } } as unknown as typeof eventDraft,
        metadata,
      ),
    ).toThrow(EventDraftError);
  });

  it("rejects invalid identifiers and timestamps", () => {
    const eventDraft = draft("agent.registered", null, MAC, agentRegistered(), {});
    for (const invalid of [
      { ...metadata, event_id: "bad" },
      { ...metadata, observed_tip: "bad" },
      { ...metadata, created_at: "yesterday" },
    ]) {
      expect(() => finalizeEvent(eventDraft, invalid)).toThrow(EventDraftError);
    }
  });

  it("requires null task IDs for registration and a task ID for task events", () => {
    expect(() =>
      finalizeEvent(draft("agent.registered", T1, MAC, agentRegistered(), {}), metadata),
    ).toThrow(EventDraftError);
    expect(() =>
      finalizeEvent(
        draft("task.cancelled", null, "human", { reason: "Stop" }, { task_rev: 1 }),
        metadata,
      ),
    ).toThrow(EventDraftError);
  });
});
