import { describe, expect, it } from "vitest";
import { anchorAt, FOLLOW, scrollAnchor, viewWindow } from "./scroll.js";
import {
  DROPPED_MARKER,
  entryRows,
  TRANSCRIPT_MAX_CHARS,
  Transcript,
  TranscriptRows,
} from "./transcript.js";

describe("Transcript retention (locked §9.3: same session, max 500K)", () => {
  it("keeps everything below the cap: no entry-count limit", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 5_000; n++) transcript.append(`line ${n}`, "info");
    expect(transcript.length).toBe(5_000);
    expect(transcript.dropped).toBe(0);
    expect(transcript.at(0)?.text).toBe("line 0");
    expect(TRANSCRIPT_MAX_CHARS).toBe(500_000);
  });

  it("evicts the oldest entries past the cap and shows one marker in their place", () => {
    const transcript = new Transcript(100);
    for (let n = 0; n < 30; n++) transcript.append(`entry-${String(n).padStart(2, "0")}`, "info");
    // 8 characters each: 12 fit in 100.
    expect(transcript.size).toBeLessThanOrEqual(100);
    expect(transcript.dropped).toBe(18);
    expect(transcript.at(0)).toMatchObject({ text: DROPPED_MARKER, marker: true });
    expect(transcript.at(1)?.text).toBe("entry-18");
    expect(transcript.entries().map((entry) => entry.text)).toHaveLength(12);
    // Sequence numbers stay contiguous across the marker.
    for (let index = 1; index < transcript.length; index++) {
      expect(transcript.at(index)?.seq).toBe((transcript.at(index - 1)?.seq ?? 0) + 1);
    }
  });

  it("keeps the newest entry even when it alone is over the cap", () => {
    const transcript = new Transcript(10);
    transcript.append("short", "info");
    transcript.append("x".repeat(50), "error");
    expect(transcript.entries().map((entry) => entry.text)).toEqual(["x".repeat(50)]);
  });

  it("maps an evicted seq to the first entry", () => {
    const transcript = new Transcript(20);
    for (let n = 0; n < 10; n++) transcript.append("0123456789", "info");
    expect(transcript.indexOfSeq(0)).toBe(0);
    expect(transcript.indexOfSeq(9)).toBe(transcript.length - 1);
  });
});

describe("TranscriptRows", () => {
  it("wraps every tone; a gutter repeats on continuation rows", () => {
    const info = entryRows({ seq: 0, tone: "info", text: "a ".repeat(60).trim() }, 40);
    expect(info.length).toBeGreaterThan(2);
    expect(info.every((row) => row.length <= 40 && !row.endsWith("…"))).toBe(true);
    const tail = entryRows(
      { seq: 1, tone: "muted", text: "word ".repeat(30).trim(), gutter: "I-4 │ " },
      40,
    );
    expect(tail[0]?.startsWith("  I-4 │ word")).toBe(true);
    expect(tail.slice(1).every((row) => row.startsWith("  I-4 │ "))).toBe(true);
    expect(tail.join(" ").match(/word/g)).toHaveLength(30);
  });

  it("extends offsets on append and rebuilds after eviction and resize", () => {
    const transcript = new Transcript(400);
    const rows = new TranscriptRows(transcript);
    for (let n = 0; n < 5; n++) transcript.append("x".repeat(60), "info");
    expect(rows.sync(40).totalRows).toBe(10);
    transcript.append("y".repeat(10), "info");
    expect(rows.sync(40).totalRows).toBe(11);
    expect(rows.sync(80).totalRows).toBe(6);
    for (let n = 0; n < 10; n++) transcript.append("z".repeat(60), "info");
    const space = rows.sync(80);
    // The marker row plus what fits in 400 characters.
    expect(space.entryCount).toBe(transcript.length);
    expect(space.window(0, 1)[0]?.text).toContain(DROPPED_MARKER);
    expect(space.totalRows).toBe(transcript.length);
  });

  it("windows rows across entry boundaries", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 4; n++) transcript.append(`${n} ${"w ".repeat(30).trim()}`, "info");
    const space = new TranscriptRows(transcript).sync(30);
    const all = space.window(0, space.totalRows).map((row) => row.text);
    expect(all).toHaveLength(space.totalRows);
    expect(space.window(3, 4).map((row) => row.text)).toEqual(all.slice(3, 7));
  });

  it("lays out 20 000 entries once and then frames in well under one tick", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 20_000; n++) transcript.append(`entry ${n} ${"text ".repeat(4)}`, "info");
    const rows = new TranscriptRows(transcript);
    rows.sync(120);
    let anchor = FOLLOW;
    const started = performance.now();
    for (let frame = 0; frame < 100; frame++) {
      transcript.append(`new ${frame}`, "event");
      const space = rows.sync(120);
      anchor = scrollAnchor(anchor, 7, space, 30);
      space.window(viewWindow(anchor, space, 30).top, 30);
    }
    const perFrame = (performance.now() - started) / 100;
    // TICK_MS is 250; a generous bound keeps this stable on a loaded CI machine.
    expect(perFrame).toBeLessThan(25);
  });
});

describe("TranscriptRows with a filter (panels, ORCH-5)", () => {
  it("lays out only the accepted entries and keeps up with appends", () => {
    const transcript = new Transcript();
    transcript.append("main only", "info");
    transcript.append("peer-1 result", "event", undefined, { peer: "peer-1" });
    transcript.append("peer-1 progress", "muted", undefined, { peer: "peer-1", panelOnly: true });
    const main = new TranscriptRows(transcript, (entry) => entry.panelOnly !== true).sync(80);
    const peer = new TranscriptRows(transcript, (entry) => entry.peer === "peer-1").sync(80);
    expect(main.window(0, 10).map((row) => row.entry.text)).toEqual(["main only", "peer-1 result"]);
    expect(peer.window(0, 10).map((row) => row.entry.text)).toEqual([
      "peer-1 result",
      "peer-1 progress",
    ]);
    transcript.append("peer-1 later", "event", undefined, { peer: "peer-1" });
    expect(peer.sync(80).entryCount).toBe(3);
    expect(main.sync(80).entryCount).toBe(3);
    // A panel-only tag without a peer would show nowhere: it is stored as a main entry.
    expect(
      transcript.append("x", "info", undefined, { panelOnly: true }).panelOnly,
    ).toBeUndefined();
  });

  it("maps seqs that are not in the view to the next entry that is", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 6; n++) {
      transcript.append(`e${n}`, "info", undefined, n % 2 === 0 ? { peer: "p" } : undefined);
    }
    const view = new TranscriptRows(transcript, (entry) => entry.peer === "p").sync(80);
    expect([view.seqAt(0), view.seqAt(1), view.seqAt(2)]).toEqual([0, 2, 4]);
    expect(view.indexOfSeq(1)).toBe(1);
    expect(view.indexOfSeq(4)).toBe(2);
    expect(view.indexOfSeq(99)).toBe(2);
  });

  it("shows the drop marker in every view after eviction", () => {
    const transcript = new Transcript(40);
    for (let n = 0; n < 10; n++) {
      transcript.append(`entry-${n}`, "info", undefined, n % 2 === 0 ? { peer: "p" } : undefined);
    }
    const view = new TranscriptRows(transcript, (entry) => entry.peer === "p").sync(80);
    const texts = view.window(0, 20).map((row) => row.entry.text);
    expect(texts[0]).toContain(DROPPED_MARKER);
    expect(texts.slice(1).every((text) => ["entry-6", "entry-8"].includes(text))).toBe(true);
  });
});

describe("viewport anchors", () => {
  it("pins by entry: output below and a resize keep the same top entry", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 50; n++) transcript.append(`entry ${n} ${"word ".repeat(15)}`, "info");
    const rows = new TranscriptRows(transcript);
    let space = rows.sync(80);
    const anchor = anchorAt(space.rowStart(10), space, 20);
    expect(anchor).toEqual({ kind: "pinned", seq: 10, row: 0 });
    transcript.append("below", "info");
    space = rows.sync(80);
    expect(space.window(viewWindow(anchor, space, 20).top, 1)[0]?.entry.seq).toBe(10);
    space = rows.sync(30);
    expect(space.window(viewWindow(anchor, space, 20).top, 1)[0]?.entry.seq).toBe(10);
  });

  it("scrolling down to the last page follows again; up stops at the first row", () => {
    const transcript = new Transcript();
    for (let n = 0; n < 100; n++) transcript.append(`line ${n}`, "info");
    const space = new TranscriptRows(transcript).sync(80);
    let anchor = scrollAnchor(FOLLOW, 1_000, space, 10);
    expect(viewWindow(anchor, space, 10)).toEqual({ top: 0, above: 0, below: 90 });
    anchor = scrollAnchor(anchor, -85, space, 10);
    expect(anchor.kind).toBe("pinned");
    anchor = scrollAnchor(anchor, -5, space, 10);
    expect(anchor).toEqual(FOLLOW);
  });

  it("a pinned entry that was evicted shows the first row", () => {
    const transcript = new Transcript(60);
    for (let n = 0; n < 5; n++) transcript.append("0123456789", "info");
    const rows = new TranscriptRows(transcript);
    const anchor = { kind: "pinned", seq: 0, row: 0 } as const;
    for (let n = 0; n < 20; n++) transcript.append("0123456789", "info");
    const space = rows.sync(80);
    expect(viewWindow(anchor, space, 3).top).toBe(0);
  });
});
