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
