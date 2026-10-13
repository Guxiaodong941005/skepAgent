// Frame goldens of the shell (ASCII glyphs, 80x24) for each session truth the controller exposes.
import { describe, expect, it } from "vitest";
import { FOLD_LINES, ShellModel, wrapLine } from "./model.js";

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
    // Every tone wraps (S1): the info line is complete, no row ends with an ellipsis.
    const infoRows = rows.slice(rows.findIndex((row) => row.startsWith("  info")));
    expect(infoRows.join("").match(/i/g)?.length).toBeGreaterThanOrEqual(201);
    for (const row of rows) expect(row.endsWith("…")).toBe(false);
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
    // Resizing while scrolled to the top keeps the same top entry in view (§5.1).
    at(120);
    shell.scrollBy(Number.MAX_SAFE_INTEGER);
    expect(at(40)).toContain("e000");
    expect(shell.scroll).toBe(shell.maxScroll());
    expect(at(200)).toContain("e000");
    // New lines below keep a scrolled-up reader on the same rows; the indicator counts them (S6).
    at(80);
    shell.scrollBy(-Number.MAX_SAFE_INTEGER);
    shell.scrollBy(5);
    const body = (frame: string) => frame.split("\n").filter((row) => !row.includes("lines below"));
    const view = at(80);
    expect(view).toMatch(/[↑^] \d+ lines above/);
    expect(view).toMatch(/5 lines below — End to follow/);
    shell.append("x ".repeat(300).trim(), "error");
    const after = at(80);
    expect(body(after)).toEqual(body(view));
    expect(after).toMatch(/\d+ lines below — End to follow/);
    expect(after).not.toMatch(/ 5 lines below/);
    shell.scrollToBottom();
    expect(at(80)).not.toContain("lines below");
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

describe("split panels (ORCH-5)", () => {
  const progress = (phase: "idle" | "working", summary: string) => ({
    phase,
    done: phase === "working" ? 1 : 0,
    total: phase === "working" ? 2 : 0,
    failed: 0,
    percent: phase === "working" ? 50 : 0,
    summary,
  });

  function split(columns = 120, rows = 30): { shell: ShellModel; lines: () => string[] } {
    const shell = model();
    shell.sessionLive = true;
    shell.header.session = "master · code 1234-5678-9012 · 192.168.1.20:7419";
    shell.peers = [
      {
        peerId: "peer-1",
        device: "mac",
        role: "coding",
        state: "joined",
        progress: progress("working", "editing api.ts"),
      },
      {
        peerId: "peer-2",
        device: "vps",
        role: "web",
        state: "joined",
        progress: progress("idle", ""),
      },
    ];
    shell.layout = "split";
    shell.append("> fix the login bug", "muted");
    shell.append("I-1 done · mac (app)", "event", undefined, { peer: "peer-1" });
    shell.append("working 50% 1/2 · editing api.ts", "muted", undefined, {
      peer: "peer-1",
      panelOnly: true,
    });
    shell.append("I-2 FAILED · vps (web)", "error", undefined, { peer: "peer-2" });
    const lines = () =>
      shell
        .frame(columns, rows)
        .map((line) => (typeof line === "string" ? line : line.spans.map((s) => s.text).join("")));
    return { shell, lines };
  }

  it("draws the main panel left and one titled panel per peer right, each row exactly wide", () => {
    const { lines } = split();
    const frame = lines();
    expect(frame.every((line) => displayWidthOf(line) <= 120)).toBe(true);
    const body = frame.filter((line) => line[66] === "|");
    expect(body.length).toBeGreaterThan(10);
    expect(body.every((line) => displayWidthOf(line) === 120)).toBe(true);
    const text = frame.join("\n");
    expect(text).toMatch(/> main/);
    expect(text).toMatch(/peer-1 \| mac \| coding \| working 50% 1\/2 · editing/);
    expect(text).toMatch(/peer-2 \| vps \| web \| idle/);
    expect(frame.join("\n")).toMatchSnapshot();
  });

  it("a peer panel shows its own entries and timeline; the main view never shows the timeline", () => {
    const { shell, lines } = split();
    const right = (line: string) => line.slice(67);
    const left = (line: string) => line.slice(0, 66);
    const frame = lines().filter((line) => line[66] === "|");
    const peerColumn = frame.map(right).join("\n");
    expect(peerColumn).toContain("I-1 done · mac (app)");
    expect(peerColumn).toContain("I-2 FAILED · vps (web)");
    const mainColumn = frame.map(left).join("\n");
    expect(mainColumn).toContain("> fix the login bug");
    expect(mainColumn).toContain("I-1 done");
    expect(mainColumn).not.toContain("editing api.ts");
    expect(shell.scrollback.map((entry) => entry.text)).not.toContain(
      "working 50% 1/2 · editing api.ts",
    );
    // Single layout ignores the tags: the same main view as before panels existed.
    shell.layout = "single";
    const single = lines().join("\n");
    expect(single).toContain("I-2 FAILED");
    expect(single).not.toContain("1/2 · editing api.ts\n");
  });

  it("stacks the panels on an 80-column terminal", () => {
    const { lines } = split(80, 30);
    const frame = lines();
    expect(frame.some((line) => line.includes("|  "))).toBe(false);
    const titles = frame.filter((line) => /^-- (> )?(main|peer-\d)/.test(line));
    expect(titles.map((line) => line.slice(3, 12))).toEqual([
      "> main --",
      "peer-1 | ",
      "peer-2 | ",
    ]);
  });

  it("scroll keys move only the focused panel; zoom shows it alone", () => {
    const { shell, lines } = split();
    for (let n = 0; n < 60; n++)
      shell.append(`peer-1 line ${n}`, "info", undefined, { peer: "peer-1" });
    lines();
    shell.focus = "peer-1";
    expect(shell.activePanel).toBe("peer-1");
    shell.scrollBy(5);
    lines();
    expect(shell.anchor.kind).toBe("bottom");
    expect(shell.scroll).toBe(5);
    expect(lines().join("\n")).toMatch(/> peer-1 \| scrolled \| mac/);
    shell.zoomed = true;
    const zoomed = lines();
    expect(zoomed.some((line) => line[66] === "|")).toBe(false);
    expect(zoomed.join("\n")).not.toContain("> fix the login bug");
    // A focused peer that left gives the keys back to the main view.
    shell.peers = shell.peers.filter((peer) => peer.peerId !== "peer-1");
    expect(shell.activePanel).toBe("main");
  });

  it("findBack pins the focused panel to the newest earlier match", () => {
    const { shell, lines } = split(120, 24);
    for (let n = 0; n < 80; n++) shell.append(`filler ${n}`, "info");
    lines();
    expect(shell.findBack("login bug")).toBe(true);
    expect(shell.anchor).toMatchObject({ kind: "pinned", row: 0 });
    expect(lines().join("\n")).toContain("> fix the login bug");
    expect(shell.findBack("login bug")).toBe(false);
    expect(shell.findBack("nothing like this")).toBe(false);
  });
});

describe("per-item folding (ORCH-7)", () => {
  const block = (lines: number) =>
    [
      "I-4 done · mac (app)",
      ...Array.from({ length: lines - 1 }, (_, n) => `  line ${n + 1}`),
    ].join("\n");

  function folded() {
    const shell = model();
    shell.sessionLive = true;
    shell.peers = [{ peerId: "peer-1", device: "mac", role: "coding", state: "joined" }];
    shell.append(block(FOLD_LINES + 5), "event", undefined, { peer: "peer-1", fold: "I-4" });
    shell.append("after the result", "info");
    const frame = (columns = 120, rows = 40) =>
      shell
        .frame(columns, rows)
        .map((line) => (typeof line === "string" ? line : line.spans.map((s) => s.text).join("")));
    return { shell, frame };
  }

  it("the main view shows the head and one hint; the rest waits for /expand", () => {
    const { frame } = folded();
    const text = frame().join("\n");
    expect(text).toContain(`line ${FOLD_LINES - 1}`);
    expect(text).not.toContain(`line ${FOLD_LINES}\n`);
    expect(text).not.toMatch(new RegExp(`line ${FOLD_LINES + 4}\\b`));
    expect(text).toContain("… 5 more lines · /expand I-4 or the peer-1 panel");
    expect(text).toContain("after the result");
  });

  it("/expand shows the rest in place and drops the hint; folding again restores it", () => {
    const { shell, frame } = folded();
    expect(shell.setExpanded("I-4", true)).toEqual(["I-4"]);
    const open = frame().join("\n");
    expect(open).toMatch(new RegExp(`line ${FOLD_LINES + 4}\\n\\s*after the result`));
    expect(open).not.toContain("more lines");
    expect(shell.setExpanded("I-4", true)).toEqual([]);
    expect(shell.setExpanded(null, false)).toEqual(["I-4"]);
    expect(frame().join("\n")).toContain("… 5 more lines");
    expect(shell.setExpanded("I-9", true)).toEqual([]);
    expect(shell.setExpanded("all", true)).toEqual(["I-4"]);
  });

  it("the peer panel always shows the whole block, never the hint", () => {
    const { shell, frame } = folded();
    shell.layout = "split";
    const peerColumn = frame()
      .filter((line) => line[66] === "|")
      .map((line) => line.slice(67))
      .join("\n");
    expect(peerColumn).toContain(`line ${FOLD_LINES + 4}`);
    expect(peerColumn).not.toContain("more lines");
  });

  it("a short block is not folded and the scrollback keeps every line", () => {
    const shell = model();
    shell.append(block(FOLD_LINES + 1), "event", undefined, { fold: "I-5" });
    expect(shell.setExpanded("I-5", true)).toEqual([]);
    const { shell: long } = folded();
    const lines = long.scrollback.map((entry) => entry.text);
    expect(lines).toContain(`  line ${FOLD_LINES + 4}`);
    expect(lines.some((line) => line.includes("more lines"))).toBe(false);
  });
});

function displayWidthOf(line: string): number {
  return [...line].length;
}
