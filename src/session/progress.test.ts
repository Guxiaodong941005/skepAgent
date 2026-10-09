import { describe, expect, it } from "vitest";
import type { ItemStatus } from "./messages.js";
import {
  deriveProgress,
  type PeerProgress,
  ProgressCoalescer,
  type ProgressValue,
  percentOf,
  progressInterval,
  type SubAgentState,
  subProgress,
} from "./progress.js";

function item(itemId: string, state: ItemStatus["state"], extra: Partial<ItemStatus> = {}) {
  return {
    itemId,
    repo: "app",
    assignee: "peer-1",
    epoch: 1,
    title: `title ${itemId}`,
    datalistEntries: 0,
    state,
    ...extra,
  } satisfies ItemStatus;
}

function result(checks: { name: string; status: "pass" | "fail" | "skip" }[]) {
  return {
    itemId: "I-1",
    epoch: 1,
    repo: "app",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checks,
    summary: "done",
  };
}

describe("percentOf", () => {
  it("floors and treats 0/0 as 0", () => {
    expect([percentOf(0, 0), percentOf(1, 3), percentOf(2, 3), percentOf(3, 3)]).toEqual([
      0, 33, 66, 100,
    ]);
  });
});

describe("progressInterval", () => {
  it("defaults to 500 ms, allows 0 and rejects negatives", () => {
    expect(progressInterval(undefined)).toBe(500);
    expect(progressInterval(0)).toBe(0);
    expect(() => progressInterval(-1)).toThrow(/non-negative/);
    expect(() => progressInterval(Number.NaN)).toThrow(/non-negative/);
  });
});

describe("deriveProgress", () => {
  it("is idle with no assigned items", () => {
    expect(
      deriveProgress([item("I-1", "planned", { assignee: "peer-2" })], "peer-1", null),
    ).toEqual({ phase: "idle", done: 0, total: 0, failed: 0, percent: 0, summary: "" });
  });

  it("is working while an item is claimed and names it", () => {
    expect(deriveProgress([item("I-1", "done"), item("I-2", "claimed")], "peer-1", null)).toEqual({
      phase: "working",
      done: 1,
      total: 2,
      failed: 0,
      percent: 50,
      summary: "title I-2",
      itemId: "I-2",
    });
  });

  it("is done when every assigned item finished", () => {
    expect(deriveProgress([item("I-1", "done")], "peer-1", { phase: "done", summary: "" })).toEqual(
      { phase: "done", done: 1, total: 1, failed: 0, percent: 100, summary: "" },
    );
  });

  it("counts a dropped item and a failing check as failed and done", () => {
    const items = [
      item("I-1", "failed"),
      item("I-2", "done", { result: result([{ name: "test", status: "fail" }]) }),
      item("I-3", "done", { result: result([{ name: "test", status: "pass" }]) }),
      item("I-4", "planned"),
    ];
    expect(deriveProgress(items, "peer-1", null)).toMatchObject({
      phase: "idle",
      done: 3,
      total: 4,
      failed: 2,
      percent: 75,
    });
  });

  it("lets a reported blocked win, even at 100 % (accepted pending result)", () => {
    // Intended: the code is in, but a human still owes an answer or a submit.
    expect(
      deriveProgress([item("I-1", "done")], "peer-1", { phase: "blocked", summary: "" }),
    ).toMatchObject({ phase: "blocked", percent: 100, done: 1, total: 1 });
    expect(
      deriveProgress([item("I-1", "claimed")], "peer-1", { phase: "blocked", summary: "" }).phase,
    ).toBe("blocked");
  });

  it("takes a reported working phase and keeps derived counts", () => {
    expect(
      deriveProgress([item("I-1", "planned")], "peer-1", { phase: "working", summary: "" }),
    ).toMatchObject({ phase: "working", done: 0, total: 1 });
  });

  it("uses the reported summary only for an item assigned to the peer", () => {
    const items = [item("I-1", "claimed"), item("I-9", "claimed", { assignee: "peer-2" })];
    expect(
      deriveProgress(items, "peer-1", { phase: "working", summary: "reported", itemId: "I-1" }),
    ).toMatchObject({ summary: "reported", itemId: "I-1" });
    expect(
      deriveProgress(items, "peer-1", { phase: "working", summary: "spoofed", itemId: "I-9" }),
    ).toMatchObject({ summary: "title I-1", itemId: "I-1" });
    expect(deriveProgress(items, "peer-1", { phase: "working", summary: "no item" })).toMatchObject(
      { summary: "title I-1", itemId: "I-1" },
    );
  });

  it("redacts a secret in the reported summary and caps it at 120 chars", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const value = deriveProgress([item("I-1", "claimed")], "peer-1", {
      phase: "working",
      summary: `push ${token}`,
      itemId: "I-1",
    });
    expect(value.summary).toBe("push [REDACTED:github-token]");
    expect(
      deriveProgress([item("I-1", "claimed", { title: "t".repeat(200) })], "peer-1", null).summary,
    ).toHaveLength(120);
  });
});

describe("subProgress", () => {
  const sub = (
    items: { itemId: string; state: "claiming" | "working" | "sent" | "done" | "rejected" }[],
    agents: Record<string, SubAgentState> = {},
    blocked = false,
  ) =>
    subProgress(
      items.map((entry) => ({ ...entry, title: `title ${entry.itemId}` })),
      new Map(Object.entries(agents)),
      blocked,
    );

  it("is idle before any item", () => {
    expect(sub([])).toEqual({
      phase: "idle",
      done: 0,
      total: 0,
      failed: 0,
      percent: 0,
      summary: "",
    });
  });

  it("excludes a rejected claim from the total", () => {
    expect(
      sub([
        { itemId: "I-1", state: "rejected" },
        { itemId: "I-2", state: "done" },
      ]),
    ).toEqual({ phase: "done", done: 1, total: 1, failed: 0, percent: 100, summary: "" });
    expect(sub([{ itemId: "I-1", state: "rejected" }]).phase).toBe("idle");
  });

  it("is working while an item is in flight and names the latest one", () => {
    expect(
      sub([
        { itemId: "I-1", state: "working" },
        { itemId: "I-2", state: "claiming" },
        { itemId: "I-3", state: "done" },
      ]),
    ).toMatchObject({ phase: "working", done: 1, total: 3, summary: "title I-2", itemId: "I-2" });
    expect(sub([{ itemId: "I-1", state: "done" }], { "I-1": "running" }).phase).toBe("working");
  });

  it("counts failed agents only on finished items", () => {
    expect(
      sub(
        [
          { itemId: "I-1", state: "done" },
          { itemId: "I-2", state: "sent" },
        ],
        { "I-1": "failed", "I-2": "failed" },
      ),
    ).toMatchObject({ phase: "working", done: 1, failed: 1, total: 2 });
  });

  it("is blocked while an agent is blocked, and stays blocked once it was", () => {
    expect(sub([{ itemId: "I-1", state: "working" }], { "I-1": "blocked" }).phase).toBe("blocked");
    expect(sub([{ itemId: "I-1", state: "done" }], { "I-1": "done" }, true)).toMatchObject({
      phase: "blocked",
      percent: 100,
    });
  });
});

describe("ProgressCoalescer", () => {
  function harness(intervalMs = 500) {
    let now = 0;
    let timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
    const sent: ProgressValue[] = [];
    const coalescer = new ProgressCoalescer<ProgressValue>({
      intervalMs,
      monotonicMs: () => now,
      schedule: (ms, fn) => {
        const timer = { at: now + ms, fn, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      send: (value) => sent.push(value),
    });
    const advance = (ms: number) => {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) if (!timer.cancelled) timer.fn();
    };
    const pending = () => timers.filter((timer) => !timer.cancelled).length;
    return { coalescer, sent, advance, pending };
  }
  const value = (phase: ProgressValue["phase"], done: number, total = 10): ProgressValue => ({
    phase,
    done,
    total,
    failed: 0,
    percent: percentOf(done, total),
    summary: "",
  });

  it("sends the first push at once", () => {
    const h = harness();
    h.coalescer.push(value("working", 0));
    expect(h.sent).toEqual([value("working", 0)]);
    expect(h.pending()).toBe(0);
  });

  it("collapses pushes inside the window into one trailing send of the latest value", () => {
    const h = harness();
    h.coalescer.push(value("working", 0));
    h.advance(100);
    for (let done = 1; done <= 5; done++) h.coalescer.push(value("working", done));
    expect(h.sent).toHaveLength(1);
    expect(h.pending()).toBe(1);
    h.advance(399);
    expect(h.sent).toHaveLength(1);
    h.advance(1);
    expect(h.sent).toEqual([value("working", 0), value("working", 5)]);
    // The window restarts at the trailing send.
    h.coalescer.push(value("working", 6));
    expect(h.sent).toHaveLength(2);
    h.advance(500);
    expect(h.sent.at(-1)).toEqual(value("working", 6));
  });

  it("sends a phase change at once and discards the pending value", () => {
    const h = harness();
    h.coalescer.push(value("working", 0));
    h.coalescer.push(value("working", 1));
    h.coalescer.push(value("blocked", 1));
    expect(h.sent).toEqual([value("working", 0), value("blocked", 1)]);
    expect(h.pending()).toBe(0);
  });

  it("drops a value equal to the last one sent", () => {
    const h = harness();
    h.coalescer.push(value("working", 0));
    h.advance(1000);
    h.coalescer.push(value("working", 0));
    expect(h.sent).toHaveLength(1);
    h.coalescer.push(value("working", 1));
    expect(h.sent).toHaveLength(2);
    // Changing back inside the window cancels the trailing send instead of repeating.
    h.coalescer.push(value("working", 2));
    h.coalescer.push(value("working", 1));
    h.advance(1000);
    expect(h.sent).toEqual([value("working", 0), value("working", 1)]);
  });

  it("stops the trailing send on cancel", () => {
    const h = harness();
    h.coalescer.push(value("working", 0));
    h.coalescer.push(value("working", 1));
    h.coalescer.cancel();
    h.advance(1000);
    expect(h.sent).toHaveLength(1);
  });

  it("sends every change with a 0 ms window", () => {
    const h = harness(0);
    for (let done = 0; done < 3; done++) h.coalescer.push(value("working", done));
    expect(h.sent).toHaveLength(3);
  });

  it("compares identity fields too", () => {
    const sent: PeerProgress[] = [];
    const coalescer = new ProgressCoalescer<PeerProgress>({
      intervalMs: 0,
      monotonicMs: () => 0,
      schedule: () => () => {},
      send: (p) => sent.push(p),
    });
    const base = { peerId: "peer-1", device: "mac", role: null, ...value("idle", 0, 0) };
    coalescer.push(base);
    coalescer.push({ ...base, role: "backend" });
    coalescer.push({ ...base, role: "backend" });
    expect(sent.map((p) => p.role)).toEqual([null, "backend"]);
  });
});
