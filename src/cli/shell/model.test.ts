// Frame goldens of the shell (ASCII glyphs, 80x24) for each session truth the controller exposes.
import { describe, expect, it } from "vitest";
import { ShellModel } from "./model.js";

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
