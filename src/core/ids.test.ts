import { describe, expect, it } from "vitest";
import {
  AGENT_ID_RE,
  EVENT_ID_RE,
  eventPath,
  parseAgentId,
  parseEventPath,
  parseWorkBranch,
  TASK_ID_RE,
  workBranch,
} from "./ids.js";

describe("ids", () => {
  it("validates task ids", () => {
    expect(TASK_ID_RE.test("T-20261005-7f3a")).toBe(true);
    expect(TASK_ID_RE.test("T-20261005-7F3A")).toBe(false);
    expect(TASK_ID_RE.test("T-2026105-7f3a")).toBe(false);
  });

  it("validates event ids", () => {
    expect(EVENT_ID_RE.test("evt_6c1f0e9a-3b7d-4c55-9a0e-2f1d8b7a4c21")).toBe(true);
    expect(EVENT_ID_RE.test("evt_6c1f0e9a")).toBe(false);
  });

  it("parses agent ids", () => {
    expect(parseAgentId("mac.coding")).toEqual({ device: "mac", role: "coding", instance: null });
    expect(parseAgentId("vps.coding.2")).toEqual({
      device: "vps",
      role: "coding",
      instance: 2,
    });
    expect(parseAgentId("human")).toBeNull();
    expect(AGENT_ID_RE.test("Mac.coding")).toBe(false);
  });

  it("round-trips work branches", () => {
    const b = workBranch("T-20261005-7f3a", "W2", 3);
    expect(b).toBe("skep/T-20261005-7f3a/W2/e3");
    expect(parseWorkBranch(b)).toEqual({ taskId: "T-20261005-7f3a", item: "W2", epoch: 3 });
    expect(parseWorkBranch("skep/T-20261005-7f3a/W2/e0")).toBeNull();
  });

  it("round-trips event paths", () => {
    const id = "evt_6c1f0e9a-3b7d-4c55-9a0e-2f1d8b7a4c21";
    expect(parseEventPath(eventPath(null, id))).toEqual({ taskId: null, eventId: id });
    expect(parseEventPath(eventPath("T-20261005-7f3a", id))).toEqual({
      taskId: "T-20261005-7f3a",
      eventId: id,
    });
    expect(parseEventPath(`events/../${id}.json`)).toBeNull();
  });
});
