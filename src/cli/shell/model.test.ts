// Frame goldens of the shell (ASCII glyphs, 80x24) for each session truth the controller exposes.
import { describe, expect, it } from "vitest";
import { ShellModel, wrapLine } from "./model.js";

function text(model: ShellModel): string {
  return model
    .frame(80, 24)
    .map((line) => (typeof line === "string" ? line : line.spans.map((span) => span.text).join("")))
    .map((line) => line.trimEnd())
    .join("\n");
}

function model(): ShellModel {
  const shell = new ShellModel();
  shell.glyphs = "ascii";
  shell.version = "0.0.0-test";
  shell.header = { device: "laptop", cwd: "~/app", session: "no session" };
  return shell;
}

describe("shell frames", () => {
  it("no session: no peer rows, ever", () => {
    const shell = model();
    // Rows left behind by a flow that ended must not render without a live session.
    shell.peers = [{ peerId: "peer-2", device: "vps", role: "web", state: "idle" }];
    const frame = text(shell);
    expect(frame).toContain("no session");
    expect(frame).toContain("(no session — /start or /join)");
    expect(frame).not.toMatch(/vps/);
    expect(frame).toMatchSnapshot();
  });

  it("master with no peers", () => {
    const shell = model();
    shell.sessionLive = true;
    shell.header.session = "master · code 1234-5678-9012 · 192.168.1.20:7419";
    const frame = text(shell);
    expect(frame).toContain("peers 0");
    expect(frame).toContain("(no peers yet)");
    expect(frame).toMatchSnapshot();
  });

  it("joined, with a healthy and a quiet peer", () => {
    const shell = model();
    shell.sessionLive = true;
    shell.header.session = "joined 192.168.1.20:7419 as peer-3 · coding";
    shell.link = "master hb 2s";
    const progress = {
      phase: "idle" as const,
      done: 0,
      total: 0,
      failed: 0,
      percent: 0,
      summary: "",
    };
    shell.peers = [
      { peerId: "peer-1", device: "mac", role: "coding", state: "idle", progress, silentMs: 2_000 },
      { peerId: "peer-2", device: "vps", role: "web", state: "idle", progress, silentMs: 24_000 },
    ];
    const frame = text(shell);
    expect(frame).toContain("master hb 2s");
    expect(frame).toMatch(/mac .* hb 2s/);
    expect(frame).toMatch(/vps .* quiet 24s/);
    expect(frame).toMatchSnapshot();
  });
});

describe("intent peer picker frames", () => {
  it("keeps the cursor visible when the peer list is taller than the terminal body", () => {
    const shell = model();
    shell.picker = {
      title: "choose peers",
      rows: Array.from({ length: 30 }, (_, index) => ({
        label: `peer-${index + 1} device repo`,
        selected: index === 15,
      })),
      cursor: 0,
    };
    shell.sessionLive = true;
    shell.peers = shell.picker.rows.map((_row, index) => ({
      peerId: `peer-${index + 1}`,
      device: "device",
      repo: "repo",
      role: "coding",
      state: "joined",
    }));
    for (const rows of [10, 12, 24]) {
      for (const cursor of [0, 1, 15, 28, 29]) {
        shell.picker.cursor = cursor;
        const frame = shell.frame(80, rows);
        const selected = frame.filter((line) => typeof line !== "string" && line.selected);
        expect(selected).toHaveLength(1);
        expect(
          selected.map((line) =>
            typeof line === "string" ? line : line.spans.map((span) => span.text).join(""),
          ),
        ).toEqual([`  ${cursor === 15 ? "[x]" : "[ ]"} peer-${cursor + 1} device repo`]);
        expect(frame).toHaveLength(rows);
      }
    }
  });
});

describe("scrollback wrapping (SESSION-UX §3.4)", () => {
  it("a 400-character error wraps onto several rows with the whole text visible", () => {
    const shell = model();
    const words = Array.from({ length: 80 }, (_, n) => `w${String(n).padStart(3, "0")}`);
    const error = words.join(" ");
    expect(error.length).toBe(399);
    shell.append(error, "error");
    shell.append(`info ${"i".repeat(200)}`, "info");
    const rows = text(shell).split("\n");
    const errorRows = rows.filter((row) => /w\d{3}/.test(row));
    expect(errorRows.length).toBeGreaterThan(4);
    for (const row of errorRows) expect(row.length).toBeLessThanOrEqual(80);
    // Every word is on screen, in order; continuation rows hang deeper than the first.
    expect(errorRows.join(" ").match(/w\d{3}/g)).toEqual(words);
    expect(errorRows[0]?.startsWith("  w000")).toBe(true);
    expect(errorRows[1]?.startsWith("      w")).toBe(true);
    // An info line keeps one row, cut at the edge.
    const info = rows.filter((row) => row.includes("info i"));
    expect(info).toHaveLength(1);
    expect(info[0]?.length).toBe(80);
    expect(text(shell)).toMatchSnapshot();
  });

  it("scrolls by rendered rows: the start of a long error is reachable at any width", () => {
    const shell = model();
    const words = Array.from({ length: 500 }, (_, n) => `e${String(n).padStart(3, "0")}`);
    shell.append(words.join(" "), "error");
    shell.append("tail info");
    const at = (columns: number) =>
      shell
        .frame(columns, 24)
        .map((line) => (typeof line === "string" ? line : line.spans.map((s) => s.text).join("")))
        .join("\n");
    for (const columns of [80, 40, 120]) {
      at(columns);
      shell.scrollBy(Number.MAX_SAFE_INTEGER);
      const top = at(columns);
      expect(top).toContain("e000");
      expect(top).not.toContain("tail info");
      shell.scrollBy(-Number.MAX_SAFE_INTEGER);
      expect(at(columns)).toContain("tail info");
    }
    // Resizing narrower while scrolled to the top keeps the view inside the scrollback.
    at(120);
    shell.scrollBy(Number.MAX_SAFE_INTEGER);
    const before = shell.scroll;
    at(40);
    expect(shell.scroll).toBe(before);
    at(200);
    expect(shell.scroll).toBe(shell.maxScroll());
    expect(at(200)).toContain("e000");
    // New lines below keep a scrolled-up reader on the same rows.
    at(80);
    shell.scrollBy(-Number.MAX_SAFE_INTEGER);
    shell.scrollBy(5);
    const view = at(80);
    shell.append("x ".repeat(300).trim(), "error");
    expect(at(80)).toBe(view);
  });

  it("wrapLine breaks inside a word only when nothing else fits", () => {
    expect(wrapLine("  abc def", 80, "    ")).toEqual(["  abc def"]);
    expect(wrapLine(`  ${"x".repeat(30)}`, 12, "    ")).toEqual([
      "  xxxxxxxxxx",
      "    xxxxxxxx",
      "    xxxxxxxx",
      "    xxxx",
    ]);
  });
});
