import { describe, expect, it } from "vitest";
import {
  cycleFocus,
  fitLine,
  MAIN_PANEL,
  MIN_PANEL_ROWS,
  progressNote,
  resolvePanel,
  splitLayout,
  visiblePeers,
} from "./panels.js";

describe("splitLayout", () => {
  it("puts the peers in a column right of the main panel on a wide terminal", () => {
    const layout = splitLayout(120, 20, ["peer-1", "peer-2"], MAIN_PANEL, false);
    expect(layout.separator).toBe(66);
    expect(layout.panels).toEqual([
      { id: MAIN_PANEL, left: 0, top: 0, width: 66, height: 20 },
      { id: "peer-1", left: 67, top: 0, width: 53, height: 10 },
      { id: "peer-2", left: 67, top: 10, width: 53, height: 10 },
    ]);
    expect(layout.hidden).toEqual([]);
  });

  it("stacks the peers under the main panel on a narrow terminal and fills every row", () => {
    const layout = splitLayout(80, 17, ["peer-1", "peer-2", "peer-3"], MAIN_PANEL, false);
    expect(layout.separator).toBeNull();
    const [main, ...peers] = layout.panels;
    expect(main).toMatchObject({ top: 0, width: 80, height: 7 });
    expect(peers.map((panel) => panel.height)).toEqual([4, 3, 3]);
    expect(peers.at(-1)).toMatchObject({ top: 14 });
    const last = peers.at(-1);
    expect((last?.top ?? 0) + (last?.height ?? 0)).toBe(17);
  });

  it("hides the peers that do not fit but always shows the focused one", () => {
    const peers = Array.from({ length: 10 }, (_, n) => `peer-${n + 1}`);
    const layout = splitLayout(120, 9, peers, "peer-8", false);
    const shown = layout.panels.slice(1).map((panel) => panel.id);
    expect(shown).toHaveLength(Math.floor(9 / MIN_PANEL_ROWS));
    expect(shown).toContain("peer-8");
    expect(layout.hidden).toHaveLength(10 - shown.length);
  });

  it("zoom gives the focused panel the whole body", () => {
    const layout = splitLayout(120, 20, ["peer-1", "peer-2"], "peer-2", true);
    expect(layout.panels).toEqual([{ id: "peer-2", left: 0, top: 0, width: 120, height: 20 }]);
  });

  it("falls back to the main panel alone without peers or rows", () => {
    expect(splitLayout(120, 20, [], MAIN_PANEL, false).panels).toHaveLength(1);
    const short = splitLayout(120, 4, ["peer-1"], MAIN_PANEL, false);
    expect(short.panels.map((panel) => panel.id)).toEqual([MAIN_PANEL]);
    expect(short.hidden).toEqual(["peer-1"]);
  });
});

describe("panel focus", () => {
  it("cycles main → peers → main", () => {
    const peers = ["peer-1", "peer-2"];
    expect(cycleFocus(MAIN_PANEL, peers)).toBe("peer-1");
    expect(cycleFocus("peer-2", peers)).toBe(MAIN_PANEL);
    expect(cycleFocus(MAIN_PANEL, peers, -1)).toBe("peer-2");
    // A focused peer that left restarts from the main panel.
    expect(cycleFocus("peer-9", peers)).toBe("peer-1");
  });

  it("keeps the focused peer in the visible window", () => {
    expect(visiblePeers(["a", "b", "c", "d"], "d", 2)).toEqual(["c", "d"]);
    expect(visiblePeers(["a", "b", "c", "d"], MAIN_PANEL, 2)).toEqual(["a", "b"]);
    expect(visiblePeers(["a"], "a", 0)).toEqual([]);
  });

  it("resolves main, a peer id or a device only one peer has", () => {
    const peers = [
      { peerId: "peer-1", device: "mac" },
      { peerId: "peer-2", device: "vps" },
      { peerId: "peer-3", device: "vps" },
    ];
    expect(resolvePanel("Master", peers)).toBe(MAIN_PANEL);
    expect(resolvePanel("PEER-2", peers)).toBe("peer-2");
    expect(resolvePanel("mac", peers)).toBe("peer-1");
    expect(resolvePanel("vps", peers)).toBeNull();
    expect(resolvePanel("nope", peers)).toBeNull();
  });
});

describe("panel text", () => {
  it("writes a progress report as one timeline line", () => {
    expect(progressNote("joined")).toBe("joined");
    const progress = {
      phase: "working",
      done: 1,
      total: 4,
      failed: 0,
      percent: 25,
      summary: "editing api.ts",
    };
    expect(progressNote("joined", progress)).toBe("working 25% 1/4 · editing api.ts");
    expect(progressNote("joined", { ...progress, total: 0, summary: "" })).toBe("working");
  });

  it("says failed, not done, when a finished run has a failed item", () => {
    const done = { phase: "done", done: 1, total: 1, failed: 0, percent: 100, summary: "" };
    expect(progressNote("done", done)).toBe("done 100% 1/1");
    expect(progressNote("done", { ...done, failed: 1 })).toBe("failed 1 of 1");
    expect(progressNote("done", { ...done, done: 3, total: 3, failed: 1 })).toBe("failed 1 of 3");
  });

  it("cuts or pads a line to exactly its cell width", () => {
    const width = (spans: { text: string }[]) => spans.map((span) => span.text).join("").length;
    expect(width(fitLine("abc", 6))).toBe(6);
    expect(width(fitLine({ spans: [{ text: "abcdefghij" }] }, 6))).toBe(6);
  });
});
