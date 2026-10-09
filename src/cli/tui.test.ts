import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../util/clock.js";
import type { JoinAgentState, JoinViewModel } from "./commands/session.js";
import { createTheme, PLAIN_THEME, type Role, type Theme } from "./theme.js";
import {
  beeLane,
  charWidth,
  decodeKeys,
  detectGlyphs,
  type Glyphs,
  type Line,
  NF_MD_BEE,
  NF_MD_BEEHIVE,
  type ProcessHooks,
  progressBar,
  progressBarParts,
  Screen,
  TICK_MS,
  TuiJoinView,
  TuiModel,
  type TuiOptions,
  type TuiSnapshot,
  truncate,
} from "./tui.js";
import { SKEP_VERSION } from "./version.js";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

/** A fake terminal: raw-mode spy on stdin, an 80×24 buffer for stdout. */
function fakeTerminal(columns = 80, rows = 24) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn((_mode: boolean) => stdin),
  });
  let written = "";
  const stdout = {
    columns,
    rows,
    write: vi.fn((text: string) => {
      written += text;
      return true;
    }),
  };
  const hooks = new EventEmitter() as EventEmitter & ProcessHooks;
  const plainFrame = (): string[] => {
    const last = written.split("\x1b[H\x1b[2J").at(-1) ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR/DEC escapes
    return last.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\r\n");
  };
  return {
    stdin,
    stdout,
    hooks,
    output: () => written,
    /** The last full frame as plain lines (styles and highlight padding dropped). */
    frame(): string[] {
      return plainFrame().map((line) => line.trimEnd());
    },
    plainFrame,
    /** The last frame with escapes kept, to see which line is highlighted. */
    rawFrame(): string[] {
      return (written.split("\x1b[H\x1b[2J").at(-1) ?? "").split("\r\n");
    },
    press(keys: string): void {
      stdin.write(keys);
    },
    rawModes: () => stdin.setRawMode.mock.calls.map(([mode]) => mode),
  };
}

type Terminal = ReturnType<typeof fakeTerminal>;

function open(term: Terminal, extra: Partial<TuiOptions> = {}): TuiJoinView {
  return new TuiJoinView({
    io: { stdin: term.stdin, stdout: term.stdout },
    hooks: term.hooks,
    ...extra,
  });
}

const PEERS: JoinViewModel["peers"] = [
  { peerId: "peer-1", device: "laptop", role: "coding", state: "joined" },
];

function model(over: {
  itemId?: string;
  state?: JoinAgentState;
  view?: "pty" | "herdr" | "native" | "dry";
  focusCommand?: readonly string[];
  tail?: string;
  title?: string;
  policy?: JoinViewModel["submit"]["policy"];
  outcome?: JoinViewModel["submit"]["outcome"];
}): JoinViewModel {
  return {
    peers: PEERS,
    item: {
      itemId: over.itemId ?? "I-1",
      title: over.title ?? "add a health check",
      repo: "web",
      epoch: 1,
    },
    agent: {
      cli: "codex",
      view: over.view ?? "pty",
      state: over.state ?? "running",
      ...(over.focusCommand === undefined ? {} : { focusCommand: over.focusCommand }),
    },
    tail: over.tail ?? "",
    submit: {
      policy: over.policy ?? "ask",
      ...(over.outcome === undefined ? {} : { outcome: over.outcome }),
    },
  };
}

/** Lets promise callbacks (key handlers, awaited host) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const RESET = "\x1b[0m";
const TRUECOLOR = createTheme({ level: "truecolor", scheme: "dark" });
const sgr = (role: Role) => TRUECOLOR.sgr({ role });

function width(text: string): number {
  return [...text].reduce((total, char) => total + charWidth(char.codePointAt(0) ?? 0), 0);
}

/** Drops every CSI escape, as a terminal would show the text. */
function strip(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** A model frame as trimmed plain text, without a screen. */
function plain(lines: Line[]): string[] {
  return lines.map((line) =>
    (typeof line === "string" ? line : line.spans.map((span) => span.text).join("")).trimEnd(),
  );
}

/** The fixed scene of the plan's wireframe: working/blocked/done peers and two entries. */
function scene(): TuiSnapshot {
  return {
    header: { session: "s-1", device: "laptop", role: "coding" },
    peers: [
      {
        peerId: "a",
        device: "laptop",
        role: "coding",
        state: "working",
        progress: {
          phase: "working",
          done: 4,
          total: 8,
          failed: 0,
          percent: 50,
          summary: "add a health check",
        },
      },
      {
        peerId: "b",
        device: "vps",
        role: "backend",
        state: "blocked",
        progress: {
          phase: "blocked",
          done: 6,
          total: 8,
          failed: 0,
          percent: 75,
          summary: "migrate users",
        },
      },
      {
        peerId: "c",
        device: "mac",
        role: "frontend",
        state: "done",
        progress: { phase: "done", done: 8, total: 8, failed: 1, percent: 100, summary: "" },
      },
    ],
    entries: [
      {
        key: "k1",
        peerId: "a",
        item: { itemId: "I-3", title: "add a health check", repo: "web", epoch: 1 },
        agent: { cli: "claude", view: "pty", state: "running" },
        tail: Array.from({ length: 30 }, (_, i) => `tail line ${i + 1}`).join("\n"),
        submit: { policy: "ask" },
      },
      {
        key: "k2",
        peerId: "a",
        item: { itemId: "I-4", title: "rotate logs", repo: "ops", epoch: 2 },
        agent: { cli: "codex", view: "herdr", state: "blocked", focusCommand: ["herdr", "focus"] },
        tail: "",
        submit: { policy: "ask" },
      },
    ],
  };
}

function progressModel(
  phase: NonNullable<JoinViewModel["peers"][number]["progress"]>["phase"],
): JoinViewModel {
  return {
    ...model({}),
    peers: [
      ...PEERS,
      {
        peerId: "peer-2",
        device: "vps",
        role: "backend",
        state: phase,
        progress: { phase, done: 3, total: 8, failed: 0, percent: 37, summary: "health check" },
      },
    ],
  };
}

function tickClock() {
  let wake = (): void => {};
  let signal: AbortSignal | undefined;
  const sleep = vi.fn((milliseconds: number, nextSignal?: AbortSignal): Promise<void> => {
    expect(milliseconds).toBe(TICK_MS);
    signal = nextSignal;
    return new Promise((resolve, reject) => {
      const aborted = (): void => reject(new Error("aborted"));
      nextSignal?.addEventListener("abort", aborted, { once: true });
      wake = () => {
        nextSignal?.removeEventListener("abort", aborted);
        resolve();
      };
    });
  });
  const clock: Clock = { monotonicMs: () => 0, nowMs: () => 0, sleep };
  return { clock, sleep, tick: () => wake(), signal: () => signal };
}

describe("detectGlyphs", () => {
  it("honors SKEP_TUI_ASCII and SKEP_TUI_GLYPHS", () => {
    expect(detectGlyphs({ SKEP_TUI_ASCII: "1" }, () => true)).toBe("ascii");
    expect(detectGlyphs({ SKEP_TUI_GLYPHS: "ascii" }, () => true)).toBe("ascii");
    expect(detectGlyphs({ SKEP_TUI_GLYPHS: "nerd" }, () => false)).toBe("nerd");
    expect(detectGlyphs({ SKEP_TUI_GLYPHS: "unicode" }, () => false)).toBe("nerd");
  });

  it("falls back to ascii when no Nerd Font covers nf-md-bee", () => {
    expect(detectGlyphs({}, () => false)).toBe("ascii");
    expect(detectGlyphs({}, () => true)).toBe("nerd");
  });
});

describe("peer progress glyphs", () => {
  it.each(["nerd", "ascii"] as const)("renders every phase and beat with %s glyphs", (glyphs) => {
    const bee = "\u{F0FA1}";
    const beeFlower = "\u{F0FA2}";
    const hive = "\u{F10CE}";
    const expected =
      glyphs === "nerd"
        ? {
            working: [`${bee}  `, ` ${beeFlower} `, `  ${bee}`, ` ${beeFlower} `],
            blocked: [`${bee}! `, `${bee}! `, `${bee}  `, `${bee}  `],
            done: [`${hive}  `, `${hive}  `, `${hive}  `, `${hive}  `],
            idle: [".   ", ".   ", ".   ", ".   "],
          }
        : {
            working: ["~b> ", " ~b>", " >~b", " ~b>"],
            blocked: ["b!> ", "b!> ", "b>  ", "b>  "],
            done: ["ok  ", "ok  ", "ok  ", "ok  "],
            idle: [".   ", ".   ", ".   ", ".   "],
          };
    for (const phase of ["working", "blocked", "done", "idle"] as const) {
      for (let beat = 0; beat < 4; beat++) {
        const lane = beeLane(phase, beat, glyphs);
        expect(lane).toBe(expected[phase][beat]);
        expect(
          [...lane].reduce((width, char) => width + charWidth(char.codePointAt(0) ?? 0), 0),
        ).toBe(4);
        expect(beeLane(phase, beat + 4, glyphs)).toBe(lane);
      }
    }
  });

  it.each([
    [0, "░░░░░░░░", "........"],
    [37, "███░░░░░", "###....."],
    [99, "███████░", "#######."],
    [100, "████████", "########"],
  ] as const)("renders an eight-cell bar at %s%%", (percent, unicode, ascii) => {
    expect(progressBar(percent, "nerd")).toBe(unicode);
    expect(progressBar(percent, "ascii")).toBe(ascii);
    const parts = progressBarParts(percent, "nerd");
    expect(parts.filled + parts.empty).toBe(unicode);
    expect(parts.filled).toMatch(/^█*$/);
  });

  it("counts emoji and Nerd Font MD PUA as two display columns", () => {
    expect(charWidth(0x1f300)).toBe(2);
    expect(charWidth(0x1f41d)).toBe(2);
    expect(charWidth(0x1faff)).toBe(2);
    expect(charWidth(0x1f2ff)).toBe(1);
    expect(charWidth(0x1fb00)).toBe(1);
    expect(charWidth(0x61)).toBe(1);
    expect(charWidth(0xf0fa1)).toBe(2);
    expect(charWidth(0xf10ce)).toBe(2);
    expect(charWidth(0xf0000)).toBe(2);
  });
});

describe("decodeKeys", () => {
  it("decodes arrows, Enter, q, Ctrl-C and letters; swallows unknown escapes", () => {
    expect(decodeKeys("\x1b[A\x1b[B\x1bOA\r\nqx\x03A\x1b[1;5C7")).toEqual([
      { name: "up" },
      { name: "down" },
      { name: "up" },
      { name: "enter" },
      { name: "enter" },
      { name: "quit" },
      { name: "char", char: "x" },
      { name: "quit" },
      { name: "char", char: "a" },
      { name: "other" },
      { name: "other" },
    ]);
  });
});

describe("Screen", () => {
  it("enters raw mode and the alternate screen, hides the cursor, and restores on close", () => {
    const term = fakeTerminal();
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
    );
    screen.start();
    expect(term.rawModes()).toEqual([true]);
    expect(term.output()).toContain(`${ENTER_ALT}\x1b[?25l`);
    screen.close();
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(`${SHOW_CURSOR}${LEAVE_ALT}`)).toBe(true);
    expect(term.hooks.listenerCount("SIGINT")).toBe(0);
    expect(term.hooks.listenerCount("exit")).toBe(0);
  });

  it("does not touch raw mode when stdin is not a TTY", () => {
    const term = fakeTerminal();
    term.stdin.isTTY = false;
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
    );
    screen.start();
    screen.close();
    expect(term.stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("truncates every line to the terminal width", () => {
    const term = fakeTerminal(20, 24);
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
    );
    screen.start();
    screen.draw(["x".repeat(50), { spans: [{ text: "y".repeat(50) }], selected: true }, "short"]);
    expect(term.plainFrame()).toEqual([`${"x".repeat(19)}…`, `${"y".repeat(19)}…`, "short"]);
    screen.close();
  });

  it("restores the terminal on SIGINT and SIGTERM", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const term = fakeTerminal();
      const onSignal = vi.fn();
      const screen = new Screen(
        { stdin: term.stdin, stdout: term.stdout },
        { onKey: () => {}, onSignal },
        term.hooks,
      );
      screen.start();
      term.hooks.emit(signal);
      expect(term.rawModes()).toEqual([true, false]);
      expect(term.output()).toContain(LEAVE_ALT);
      expect(onSignal).toHaveBeenCalledOnce();
    }
  });

  it("restores the terminal when drawing throws, then rethrows", () => {
    const term = fakeTerminal();
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
    );
    screen.start();
    term.stdout.write.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    expect(() => screen.draw(["frame"])).toThrow("EPIPE");
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output()).toContain(LEAVE_ALT);
    expect(screen.isClosed).toBe(true);
  });
});

describe("truncate", () => {
  it("cuts with an ellipsis and strips control characters", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(truncate("a\x1b[31mb\tc", 10)).toBe("a[31mb c");
  });

  it("cuts by display width without splitting an emoji", () => {
    expect(truncate("🐝abc", 4)).toBe("🐝a…");
    expect(truncate("🐝a", 3)).toBe("🐝a");
    expect(truncate("🐝", 1)).toBe("…");
    expect(truncate("🐝", 0)).toBe("");
  });
});

describe("peer progress strips", () => {
  it.each([
    ["working", "\u{F0FA1}", "working"],
    ["blocked", "!", "blocked"],
    ["idle", ".", "idle"],
    ["done", "\u{F10CE}", "done"],
  ] as const)("draws a remote %s peer without an entry", (phase, glyph, label) => {
    const term = fakeTerminal();
    const view = open(term, { animate: false });
    try {
      view.update(progressModel(phase));
      const strip = term.frame()[3];
      expect(strip).toContain(glyph);
      expect(strip).toContain("[███░░░░░]  37%  3/8");
      expect(strip).toContain(`${label}  health check`);
      expect(term.rawFrame()[3]).not.toContain("\x1b[7m");
      expect(term.frame()[2]).toBe("> laptop  coding   I-1 e1  codex/pty  running");
      expect(term.frame()).toHaveLength(24);
    } finally {
      view.close();
    }
  });

  it("keeps self's strip before its selectable item and marks failed completion", () => {
    const term = fakeTerminal();
    const view = open(term, { animate: false });
    try {
      const snapshot = progressModel("done");
      const progress = snapshot.peers[1]?.progress;
      if (progress === undefined) throw new Error("missing test progress");
      snapshot.peers[0] = {
        ...(PEERS[0] as JoinViewModel["peers"][number]),
        progress: { ...progress, phase: "done", done: 8, failed: 1, percent: 100, summary: "" },
      };
      view.update(snapshot);
      expect(term.frame()[2]).toContain("\u{F10CE}");
      expect(term.frame()[2]).toContain("[████████] 100%  8/8  done (1 failed)");
      expect(term.frame()[3]).toBe("> laptop  coding   I-1 e1  codex/pty  running");
    } finally {
      view.close();
    }
  });

  it.each(["nerd", "ascii"] as Glyphs[])(
    "uses model.beat for %s frames and strips summary controls",
    (glyphs) => {
      const term = fakeTerminal();
      const view = open(term, { animate: false, glyphs });
      try {
        const snapshot = progressModel("working");
        const progress = snapshot.peers[1]?.progress;
        if (progress === undefined) throw new Error("missing test progress");
        progress.summary = "safe\n\r\ttext";
        view.tui.model.beat = 2;
        view.update(snapshot);
        expect(term.frame()[3]).toMatch(
          glyphs === "nerd" ? /backend\s+.*[\u{F0FA1}\u{F0FA2}]/u : /backend\s+.*~b/,
        );
        expect(term.frame()[3]).toContain("safe text");
        expect(term.frame()[3]).toContain(glyphs === "nerd" ? "███░░░░░" : "###.....");
      } finally {
        view.close();
      }
    },
  );

  it("truncates emoji lines and pads selected rows to exactly 80 display columns", () => {
    const term = fakeTerminal();
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
    );
    screen.start();
    try {
      screen.draw([
        "🐝".repeat(60),
        { spans: [{ text: "a" }, { text: "🐝" }], selected: true },
        { spans: [{ text: "🐝".repeat(60) }], selected: true },
      ]);
      const lines = term.plainFrame();
      expect(lines[0]).toBe(`${"🐝".repeat(39)}…`);
      expect(lines[1]).toBe(`a🐝${" ".repeat(77)}`);
      for (const line of lines) {
        const width = [...line].reduce(
          (total, char) => total + charWidth(char.codePointAt(0) ?? 0),
          0,
        );
        expect(width).toBeLessThanOrEqual(80);
      }
      expect(lines[2]?.endsWith("… ")).toBe(true);
    } finally {
      screen.close();
    }
  });
});

describe("peer progress ticker", () => {
  it("starts only while animating, keeps one loop, stops at idle, and aborts on close", async () => {
    const term = fakeTerminal();
    const time = tickClock();
    const view = open(term, { clock: time.clock });
    try {
      view.update(progressModel("idle"));
      expect(time.sleep).not.toHaveBeenCalled();
      view.update(progressModel("working"));
      view.tui.render();
      expect(time.sleep).toHaveBeenCalledTimes(1);
      time.tick();
      await flush();
      expect(view.tui.model.beat).toBe(1);
      expect(time.sleep).toHaveBeenCalledTimes(2);
      view.update(progressModel("idle"));
      time.tick();
      await flush();
      expect(view.tui.model.beat).toBe(1);
      expect(time.sleep).toHaveBeenCalledTimes(2);
      view.update(progressModel("done"));
      expect(time.sleep).toHaveBeenCalledTimes(2);
      view.update(progressModel("blocked"));
      expect(time.sleep).toHaveBeenCalledTimes(3);
      view.close();
      expect(time.signal()?.aborted).toBe(true);
      await flush();
      expect(time.sleep).toHaveBeenCalledTimes(3);
    } finally {
      view.close();
    }
  });

  it("advances without drawing while suspended, then redraws on resume", async () => {
    const term = fakeTerminal();
    const time = tickClock();
    const view = open(term, { clock: time.clock });
    try {
      view.update(progressModel("working"));
      view.tui.screen.suspend();
      const before = term.output();
      time.tick();
      await flush();
      expect(view.tui.model.beat).toBe(1);
      expect(term.output()).toBe(before);
      view.resume();
      expect(term.output()).not.toBe(before);
      expect(time.sleep).toHaveBeenCalledTimes(2);
    } finally {
      view.close();
      await flush();
    }
  });

  it("never sleeps when animation is disabled", () => {
    const term = fakeTerminal();
    const time = tickClock();
    const view = open(term, { clock: time.clock, animate: false });
    try {
      view.update(progressModel("working"));
      view.update(progressModel("blocked"));
      expect(time.sleep).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
});

describe("TuiJoinView frames", () => {
  const HIVE = "\u{F10CE}";

  it("draws the header, peers, item, agent, tail and footer at 80×24", () => {
    const term = fakeTerminal();
    const view = open(term);
    const tail = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    view.update(model({ state: "running", tail }));
    const frame = term.frame();
    expect(frame).toHaveLength(24);
    expect(frame[0]).toMatch(
      new RegExp(
        `^ ${HIVE} skep {3}session joined · device laptop · role coding +v${SKEP_VERSION.replaceAll(".", "\\.")}$`,
        "u",
      ),
    );
    expect(frame[1]).toMatch(/^── PEERS ─+ 1 peer ─$/);
    expect(frame[2]).toBe("> laptop  coding  I-1 e1  codex/pty  running");
    expect(frame[3]).toMatch(/^── ITEM ─+ I-1 · epoch 1 ─$/);
    expect(frame[4]).toBe("  Item    I-1 (web)  add a health check");
    expect(frame[5]).toBe("  Agent   codex · view pty · running");
    expect(frame[6]).toBe("  Submit  policy ask");
    // The tail fills the rows between the OUTPUT rule and the footer with the last lines.
    expect(frame[7]).toMatch(/^── OUTPUT ─+ last 15 of 40 ─$/);
    expect(frame.slice(8, 23)).toEqual(
      Array.from({ length: 15 }, (_, i) => `    line ${40 - 15 + i + 1}`),
    );
    expect(frame[23]?.trim()).toBe("q quit");
    // Every rule spans the width; every line fits; the footer is padded to it.
    for (const at of [1, 3, 7]) expect(width(frame[at] ?? "")).toBe(80);
    for (const line of frame) expect(width(line)).toBeLessThanOrEqual(80);
    expect(term.plainFrame()[23]).toHaveLength(80);
    view.close();
  });

  it.each([
    ["starting", []],
    ["running", []],
    ["blocked", ["          ! answer in the agent's own view (press a)"]],
    ["done", []],
    ["failed", []],
  ] as const)("shows the %s state", (state, extra) => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ state, view: "native" }));
    const frame = term.frame();
    expect(frame[2]).toBe(`> laptop  coding  I-1 e1  codex/native  ${state}`);
    const agent = frame.indexOf(`  Agent   codex · view native · ${state}`);
    expect(agent).toBeGreaterThan(0);
    expect(frame.slice(agent + 1, agent + 1 + extra.length)).toEqual(extra);
    expect(frame.join("\n").includes("answer in the agent's own view")).toBe(state === "blocked");
    view.close();
  });

  it("shows a herdr agent's focus command and offers attach while it is live", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(
      model({ state: "blocked", view: "herdr", focusCommand: ["herdr", "agent", "focus", "x"] }),
    );
    expect(term.frame()).toContain("          watch: herdr agent focus x");
    expect(term.frame()[23]?.trim()).toBe("a/⏎ attach · q quit");
    view.update(model({ state: "done", view: "herdr", focusCommand: ["herdr", "agent", "focus"] }));
    expect(term.frame()[23]?.trim()).toBe("q quit");
    view.close();
  });

  it("writes the attach key as enter in ascii mode", () => {
    const term = fakeTerminal();
    const view = open(term, { glyphs: "ascii" });
    view.update(model({ state: "running", view: "herdr", focusCommand: ["herdr", "focus"] }));
    expect(term.frame()[23]?.trim()).toBe("a/enter attach | q quit");
    view.close();
  });

  it("shows the submit outcome once there is one", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(
      model({
        state: "done",
        outcome: {
          method: "pr",
          state: "opened",
          url: "https://example.com/org/web/pull/7",
          number: 7,
          branch: "skep/session/I-1-e1",
        },
      }),
    );
    expect(term.frame()).toContain("  Submit  pr opened https://example.com/org/web/pull/7");
    view.close();
  });

  it("truncates long titles to 80 columns", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ title: "t".repeat(200) }));
    const item = term.frame().find((line) => line.startsWith("  Item"));
    expect(item).toHaveLength(80);
    expect(item?.endsWith("t…")).toBe(true);
    view.close();
  });

  it('shows only a "terminal too small" notice below 24 rows, in the error role', () => {
    const term = fakeTerminal(80, 23);
    const view = open(term, { theme: TRUECOLOR });
    view.update(model({}));
    expect(term.frame()).toEqual(["terminal too small: 80x23; resize to at least 24 rows"]);
    expect(term.rawFrame()[0]?.startsWith(sgr("error"))).toBe(true);
    view.close();
  });

  it("lists several agents; ↑/↓ moves the highlight and the detail follows", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ itemId: "I-1", tail: "one" }));
    view.update(model({ itemId: "I-2", state: "done", tail: "two" }));
    const highlighted = () => term.rawFrame().filter((line) => line.startsWith("\x1b[7m> "));
    expect(term.frame().slice(2, 4)).toEqual([
      "> laptop  coding  I-1 e1  codex/pty  running",
      "  laptop  coding  I-2 e1  codex/pty  done",
    ]);
    expect(highlighted()).toHaveLength(1);
    expect(term.frame()[23]).toMatch(/^ ↑↓ select · q quit +1\/2$/);
    term.press("\x1b[B");
    expect(term.frame()[3]).toBe("> laptop  coding  I-2 e1  codex/pty  done");
    expect(term.frame()).toContain("  Item    I-2 (web)  add a health check");
    expect(term.frame()).toContain("    two");
    expect(term.frame()[23]).toMatch(/ 2\/2$/);
    term.press("\x1b[B");
    expect(term.frame()[3]?.startsWith(">")).toBe(true);
    term.press("\x1b[A");
    expect(term.frame()[2]?.startsWith(">")).toBe(true);
    expect(term.frame()).toContain("    one");
    view.close();
  });

  it("shows calm empty states for peers, items and output", () => {
    const sub = new TuiModel();
    sub.set({ header: { session: "s", device: "d", role: "coding" }, peers: [], entries: [] });
    const frame = plain(sub.frame(80, 24));
    expect(frame[2]).toBe("  Waiting for peers: run skep session join on another device");
    expect(frame[3]).toMatch(/^── ITEM ─+$/);
    expect(frame[4]).toBe("  No item yet: the master has not assigned work to this device");
    expect(frame[5]).toMatch(/^── OUTPUT ─+$/);
    expect(frame[6]).toBe("    No output yet");
    const master = new TuiModel();
    master.set({ header: { session: "s", device: "d", role: "master" }, peers: [], entries: [] });
    expect(plain(master.frame(80, 24))).toContain("  No items yet");
  });

  it("aligns devices and roles into capped columns", () => {
    const m = new TuiModel();
    m.set(scene());
    m.snapshot.peers.push({
      peerId: "long",
      device: "a-very-long-device-name",
      role: "a-very-long-role",
      state: "joined",
    });
    const rows = plain(m.frame(100, 40)).slice(2, 7);
    expect(rows).toEqual([
      "  laptop        coding      󰾡    [████░░░░]  50%  4/8  working  add a health check",
      "> laptop        coding      I-3 e1  claude/pty  running",
      "  laptop        coding      I-4 e2  codex/herdr  blocked",
      "  vps           backend     󰾡!   [██████░░]  75%  6/8  blocked  migrate users",
      "  mac           frontend    󱃎    [████████] 100%  8/8  done (1 failed)",
    ]);
    expect(plain(m.frame(100, 40))[7]).toBe("  a-very-long…  a-very-lo…  joined");
  });

  it("sheds the done count below 70 columns and the bar below 60; drops a cramped summary", () => {
    const m = new TuiModel();
    m.set(scene());
    const strip = (columns: number) => plain(m.frame(columns, 24))[2] ?? "";
    expect(strip(80)).toBe(
      "  laptop  coding    󰾡    [████░░░░]  50%  4/8  working  add a health check",
    );
    expect(strip(69)).toBe("  laptop  coding    󰾡    [████░░░░]  50%  working  add a health check");
    expect(strip(59)).toBe("  laptop  coding    󰾡     50%  working  add a health check");
    expect(strip(40)).toBe("  laptop  coding    󰾡     50%  working");
  });

  it("drops the header's version, then its role, when the width is short", () => {
    const m = new TuiModel();
    m.glyphs = "ascii";
    m.set(scene());
    expect(plain(m.frame(80, 24))[0]).toMatch(/role coding +v/);
    expect(plain(m.frame(52, 24))[0]).toBe(" skep   session s-1 | device laptop | role coding");
    expect(plain(m.frame(44, 24))[0]).toBe(" skep   session s-1 | device laptop");
  });

  it("keeps every line within the width and pads the footer and selected row", () => {
    for (const glyphs of ["nerd", "ascii"] as const) {
      for (const [columns, rows] of [
        [80, 24],
        [100, 40],
        [60, 24],
      ] as const) {
        const m = new TuiModel();
        m.glyphs = glyphs;
        const s = scene();
        const peer = s.peers[0];
        if (peer?.progress === undefined) throw new Error("missing scene progress");
        peer.device = "device-with-a-very-long-name";
        peer.progress.summary = `🐝 ${"summary ".repeat(30)}`;
        const entry = s.entries[0];
        if (entry === undefined) throw new Error("missing scene entry");
        entry.item = { ...entry.item, title: "🐝".repeat(80) };
        m.set(s);
        const term = fakeTerminal(columns, rows);
        const screen = new Screen(
          { stdin: term.stdin, stdout: term.stdout },
          { onKey: () => {} },
          term.hooks,
          TRUECOLOR,
        );
        screen.start();
        screen.draw(m.frame(columns, rows));
        const lines = term.plainFrame();
        expect(lines).toHaveLength(rows);
        for (const line of lines) expect(width(line)).toBeLessThanOrEqual(columns);
        expect(width(lines.at(-1) ?? "")).toBe(columns);
        expect(width(lines.find((line) => line.startsWith("> ")) ?? "")).toBe(columns);
        screen.close();
      }
    }
  });

  it("uses no ambiguous-width chrome in ascii mode, and rules and the hive in nerd mode", () => {
    const ascii = new TuiModel();
    ascii.glyphs = "ascii";
    ascii.set(scene());
    const text = plain(ascii.frame(80, 24)).join("\n");
    expect(text).not.toMatch(/[─·█░\u{F0000}-\u{FFFFD}]/u);
    const nerd = new TuiModel();
    nerd.set(scene());
    const frame = plain(nerd.frame(80, 24));
    expect(frame[0]?.startsWith(` ${HIVE} skep`)).toBe(true);
    expect(frame[1]?.startsWith("── PEERS ")).toBe(true);
  });
});

describe("TuiModel colors", () => {
  function raw(theme: Theme, glyphs: Glyphs = "nerd", entries = true): string[] {
    const m = new TuiModel();
    m.glyphs = glyphs;
    const s = scene();
    if (!entries) s.entries = [];
    m.set(s);
    m.pendingSubmit.add("k1");
    const term = fakeTerminal();
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
      theme,
    );
    screen.start();
    screen.draw(m.frame(80, 24));
    const frame = term.rawFrame();
    screen.close();
    return frame;
  }

  it("uses inverse only for the selected row", () => {
    const frame = raw(TRUECOLOR);
    expect(frame.join("\n").split("\x1b[7m")).toHaveLength(2);
    expect(frame[3]?.startsWith("\x1b[7m> ")).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR
    const inverse = /\x1b\[(\d+;)*7(;\d+)*m/;
    expect(frame[0]).not.toMatch(inverse);
    expect(frame[23]).not.toMatch(inverse);
    expect(raw(TRUECOLOR, "nerd", false).join("\n")).not.toContain("\x1b[7m");
  });

  it("colors each peer phase, the bee lane and the bar through roles", () => {
    const frame = raw(TRUECOLOR);
    const [working, , , blocked, done] = frame.slice(2, 7);
    expect(working).toContain(`${sgr("primary")}${NF_MD_BEE}`);
    expect(working).toContain(`${sgr("primary")}████${RESET}${sgr("outline")}░░░░`);
    expect(working).toContain(`${sgr("primary")}working${RESET}`);
    expect(blocked).toContain(`${sgr("warning")}${NF_MD_BEE}!`);
    expect(blocked).toContain(`${sgr("warning")}blocked${RESET}`);
    expect(done).toContain(`${sgr("success")}${NF_MD_BEEHIVE}`);
    expect(done).toContain(`${sgr("error")}████████${RESET}`);
    expect(done).toContain(`${sgr("success")}done${RESET}${sgr("error")} (1 failed)${RESET}`);
    expect(frame[0]).toContain(`${TRUECOLOR.sgr({ role: "primary", bold: true })}skep`);
  });

  it("colors pending submit keys as a warning and other keys as primary", () => {
    const footer = raw(TRUECOLOR)[23] ?? "";
    expect(footer).toContain(`${TRUECOLOR.sgr({ role: "warning", bold: true })}p${RESET}`);
    expect(footer).toContain(`${TRUECOLOR.sgr({ role: "primary", bold: true })}q${RESET}`);
  });

  it("keeps the same text without color, with bold keys and no color codes", () => {
    const none = raw(PLAIN_THEME);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR
    expect(none.join("\n")).not.toMatch(/\x1b\[(\d+;)*(3\d|9\d|38)(;\d+)*m/);
    expect(none[23]).toContain("\x1b[1mq\x1b[0m");
    expect(none.map(strip)).toEqual(raw(TRUECOLOR).map(strip));
  });

  it("lets no wire text restyle the screen", () => {
    const m = new TuiModel();
    const s = scene();
    const peer = s.peers[1];
    const entry = s.entries[0];
    if (peer?.progress === undefined || entry === undefined) throw new Error("bad scene");
    peer.progress.summary = "\x1b[31mred\x1b[7m";
    peer.device = "\x1b[7mvps";
    entry.item = { ...entry.item, title: "\x1b[5mblink" };
    entry.tail = "\x1b[2Jtail\x1b[31m";
    m.set(s);
    const term = fakeTerminal();
    const screen = new Screen(
      { stdin: term.stdin, stdout: term.stdout },
      { onKey: () => {} },
      term.hooks,
      TRUECOLOR,
    );
    screen.start();
    screen.draw(m.frame(80, 24));
    const text = term.rawFrame().join("\n");
    screen.close();
    expect(text).not.toContain("\x1b[31m");
    expect(text).not.toContain("\x1b[5m");
    expect(text).not.toContain("\x1b[2J");
    expect(text.split("\x1b[7m")).toHaveLength(2);
  });

  // The visual contract: changing these snapshots needs a reviewer. ⎋ makes escapes readable.
  it.each([
    ["nerd", "truecolor", TRUECOLOR],
    ["nerd", "none", PLAIN_THEME],
    ["ascii", "truecolor", TRUECOLOR],
    ["ascii", "none", PLAIN_THEME],
  ] as const)("matches the golden %s frame with %s color", (glyphs, _level, theme) => {
    expect(raw(theme, glyphs).join("\n").replaceAll("\x1b", "⎋")).toMatchSnapshot();
  });
});

describe("TuiJoinView keys", () => {
  it("q quits: restores the terminal and reports a key quit", () => {
    const term = fakeTerminal();
    const onQuit = vi.fn();
    const view = open(term, { onQuit });
    view.update(model({}));
    term.press("q");
    expect(onQuit).toHaveBeenCalledWith("key");
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(`${SHOW_CURSOR}${LEAVE_ALT}`)).toBe(true);
    // Later updates from the join must not draw on the restored terminal.
    const before = term.output();
    view.update(model({ state: "done" }));
    expect(term.output()).toBe(before);
  });

  it("Ctrl-C quits like q", () => {
    const term = fakeTerminal();
    const onQuit = vi.fn();
    open(term, { onQuit });
    term.press("\x03");
    expect(onQuit).toHaveBeenCalledWith("key");
    expect(term.rawModes()).toEqual([true, false]);
  });

  it("a signal restores the terminal and reports a signal quit", () => {
    const term = fakeTerminal();
    const onQuit = vi.fn();
    open(term, { onQuit });
    term.hooks.emit("SIGTERM");
    expect(onQuit).toHaveBeenCalledWith("signal");
    expect(term.rawModes()).toEqual([true, false]);
  });

  it("has no approve key and never forwards input", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ state: "blocked", view: "native" }));
    const before = term.frame();
    term.press("yY\r");
    expect(term.frame()).toEqual(before);
    expect(before.join("\n")).not.toMatch(/approve/i);
    view.close();
  });

  it.each([
    ["p", "github", "pr"],
    ["p", "gitlab", "mr"],
    ["u", "github", "push"],
    ["n", "github", "none"],
    ["s", "github", null],
  ] as const)("%s on a %s device resolves chooseSubmit with %s", async (key, host, expected) => {
    const term = fakeTerminal();
    const view = open(term, { host: Promise.resolve(host) });
    const done = model({ state: "done" });
    view.update(done);
    expect(term.frame()[23]?.trim()).toBe("q quit");
    const choice = view.chooseSubmit(done);
    await flush();
    const label = host === "gitlab" ? "mr" : "pr";
    expect(term.frame()).toContain(`  Submit  p ${label} / u push / n none / s skip?`);
    expect(term.frame()[23]?.trim()).toBe(`p ${label} · u push · n none · s skip · q quit`);
    term.press(key);
    await expect(choice).resolves.toBe(expected);
    expect(term.frame()[23]?.trim()).toBe("q quit");
    view.close();
  });

  it("submit keys do nothing while no choice is pending", async () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ itemId: "I-1", state: "done" }));
    view.update(model({ itemId: "I-2", state: "done" }));
    const choice = view.chooseSubmit(model({ itemId: "I-2", state: "done" }));
    await flush();
    // The question is brought on screen; moving away hides its keys.
    expect(term.frame()[3]?.startsWith(">")).toBe(true);
    term.press("\x1b[A");
    expect(term.frame()[23]).toMatch(/^ ↑↓ select · q quit +1\/2$/);
    term.press("u");
    term.press("\x1b[B");
    term.press("n");
    await expect(choice).resolves.toBe("none");
    view.close();
  });

  it("closing resolves a pending choice with null (defer)", async () => {
    const term = fakeTerminal();
    const view = open(term);
    const choice = view.chooseSubmit(model({ state: "done" }));
    await flush();
    view.close();
    await expect(choice).resolves.toBeNull();
  });

  it("an unreadable code host is an error message and offers pr", async () => {
    const term = fakeTerminal();
    const view = open(term, { theme: TRUECOLOR, host: Promise.reject(new Error("bad toml")) });
    const choice = view.chooseSubmit(model({ state: "done" }));
    await flush();
    expect(term.frame()).toContain("  ! could not read the code host (bad toml); offering pr");
    const line = term.rawFrame().find((raw) => raw.includes("could not read the code host"));
    expect(line?.startsWith(sgr("error"))).toBe(true);
    term.press("p");
    await expect(choice).resolves.toBe("pr");
    view.close();
  });

  it("a on a PTY agent suspends the screen for it and resume() redraws", async () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ state: "running", view: "pty" }));
    let attached = false;
    const suspended = view.suspend().then(() => {
      attached = true;
    });
    await flush();
    // The agent waits for the human to hand it the terminal.
    expect(attached).toBe(false);
    expect(term.frame()).toContain("          ready: press a to give the agent this terminal");
    expect(term.frame()[23]?.trim()).toBe("a/⏎ attach · q quit");
    term.press("a");
    await suspended;
    expect(attached).toBe(true);
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(`${SHOW_CURSOR}${LEAVE_ALT}`)).toBe(true);
    // While suspended, keystrokes belong to the agent, not to the view.
    expect(term.stdin.listenerCount("data")).toBe(0);
    view.update(model({ state: "running", view: "pty" }));
    expect(term.output().endsWith(LEAVE_ALT)).toBe(true);

    view.resume();
    expect(term.rawModes()).toEqual([true, false, true]);
    const reentered = term.output().lastIndexOf(`${ENTER_ALT}\x1b[?25l\x1b[H\x1b[2J`);
    expect(reentered).toBeGreaterThan(term.output().lastIndexOf(LEAVE_ALT));
    expect(term.frame()[23]?.trim()).toBe("q quit");
    view.close();
  });

  it("Enter attaches like a", async () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ state: "running", view: "pty" }));
    const suspended = view.suspend();
    await flush();
    term.press("\r");
    await suspended;
    expect(term.rawModes()).toEqual([true, false]);
    view.close();
  });

  it("a on a herdr agent runs focus and shows the command for another terminal", async () => {
    const term = fakeTerminal();
    const runFocus = vi.fn(async (_argv: readonly string[]) => {});
    const view = open(term, { runFocus });
    const focus = ["herdr", "agent", "focus", "skep-i-1-e1"];
    view.update(model({ state: "running", view: "herdr", focusCommand: focus }));
    term.press("a");
    await flush();
    expect(runFocus).toHaveBeenCalledWith(focus);
    expect(term.frame()).toContain(
      "  focusing the agent; from another terminal: herdr agent focus skep-i-1-e1",
    );
    // herdr runs in its own pane: the view keeps the terminal.
    expect(term.rawModes()).toEqual([true]);
    view.close();
  });

  it("a failed focus is shown as an error, with the command to run by hand", async () => {
    const term = fakeTerminal();
    const view = open(term, {
      theme: TRUECOLOR,
      runFocus: async () => {
        throw new Error("herdr is not running");
      },
    });
    view.update(model({ state: "blocked", view: "herdr", focusCommand: ["herdr", "focus"] }));
    term.press("a");
    await flush();
    expect(term.frame()).toContain(
      "  ! focus failed (herdr is not running); run it yourself: herdr focus",
    );
    const line = term.rawFrame().find((raw) => raw.includes("focus failed"));
    expect(line?.startsWith(sgr("error"))).toBe(true);
    view.close();
  });

  it("a does nothing when there is nothing to attach to", () => {
    const term = fakeTerminal();
    const runFocus = vi.fn();
    const view = open(term, { runFocus });
    view.update(model({ state: "done", view: "native" }));
    term.press("a");
    expect(runFocus).not.toHaveBeenCalled();
    expect(term.rawModes()).toEqual([true]);
    view.close();
  });
});

describe("TuiJoinView errors", () => {
  it("restores the terminal after a thrown error and rethrows it", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({}));
    const broken = model({});
    Object.defineProperty(broken, "peers", {
      get() {
        throw new Error("bad model");
      },
    });
    expect(() => view.update(broken)).toThrow("bad model");
    expect(term.rawModes()).toEqual([true, false]);
    expect(term.output().endsWith(`${SHOW_CURSOR}${LEAVE_ALT}`)).toBe(true);
    expect(term.hooks.listenerCount("SIGINT")).toBe(0);
  });

  it("restores the terminal on process exit", () => {
    const term = fakeTerminal();
    open(term);
    term.hooks.emit("exit");
    expect(term.rawModes()).toEqual([true, false]);
  });
});
