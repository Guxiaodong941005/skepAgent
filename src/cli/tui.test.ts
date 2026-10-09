import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../util/clock.js";
import type { JoinAgentState, JoinViewModel } from "./commands/session.js";
import {
  beeLane,
  detectGlyphs,
  charWidth,
  decodeKeys,
  type Glyphs,
  type ProcessHooks,
  progressBar,
  Screen,
  TICK_MS,
  TuiJoinView,
  type TuiOptions,
  truncate,
} from "./tui.js";

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
  it.each(["nerd", "ascii"] as const)(
    "renders every phase and beat with %s glyphs",
    (glyphs) => {
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
    },
  );

  it.each([
    [0, "░░░░░░░░", "........"],
    [37, "███░░░░░", "###....."],
    [99, "███████░", "#######."],
    [100, "████████", "########"],
  ] as const)("renders an eight-cell bar at %s%%", (percent, unicode, ascii) => {
    expect(progressBar(percent, "nerd")).toBe(unicode);
    expect(progressBar(percent, "ascii")).toBe(ascii);
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
    screen.draw(["x".repeat(50), { text: "y".repeat(50), style: "inverse" }, "short"]);
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
      expect(term.frame()[2]).toBe("> laptop  coding  I-1 e1  codex/pty  running");
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
      expect(term.frame()[3]).toBe("> laptop  coding  I-1 e1  codex/pty  running");
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
        expect(term.frame()[3]).toMatch(glyphs === "nerd" ? /backend\s+.*[\u{F0FA1}\u{F0FA2}]/u : /backend\s+.*~b/);
        expect(term.frame()[3]).toContain("safe text");
        expect(term.frame()[3]).toContain(glyphs === "nerd" ? "███░░░░░" : "###.....");
      } finally {
        view.close();
      }
    },
  );

  it("truncates emoji lines and pads inverse rows to exactly 80 display columns", () => {
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
        { text: "a🐝", style: "inverse" },
        { text: "🐝".repeat(60), style: "inverse" },
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
  it("draws the header, peers, item, agent, tail and footer at 80×24", () => {
    const term = fakeTerminal();
    const view = open(term);
    const tail = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    view.update(model({ state: "running", tail }));
    const frame = term.frame();
    expect(frame).toHaveLength(24);
    expect(frame[0]).toBe(" skep  session joined  device laptop  role coding");
    expect(frame[1]).toBe("Peers");
    expect(frame[2]).toBe("> laptop  coding  I-1 e1  codex/pty  running");
    expect(frame).toContain("Item   I-1 (epoch 1, web): add a health check");
    expect(frame).toContain("Agent  codex  view pty  running");
    expect(frame).toContain("Submit policy ask");
    // The tail fills the rows between "Output" and the footer with the last lines.
    const out = frame.indexOf("Output");
    expect(frame.slice(out + 1, 23)).toEqual(
      Array.from({ length: 23 - out - 1 }, (_, i) => `  line ${40 - (23 - out - 1) + i + 1}`),
    );
    expect(frame[23]?.trim()).toBe("q quit");
    // Every line fits the width; the footer is padded to it.
    for (const line of frame) expect([...line].length).toBeLessThanOrEqual(80);
    expect(term.plainFrame()[23]).toHaveLength(80);
    view.close();
  });

  it.each([
    ["starting", []],
    ["running", []],
    ["blocked", ["       answer in the agent's own view (a)"]],
    ["done", []],
    ["failed", []],
  ] as const)("shows the %s state", (state, extra) => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ state, view: "native" }));
    const frame = term.frame();
    expect(frame[2]).toBe(`> laptop  coding  I-1 e1  codex/native  ${state}`);
    const agent = frame.indexOf(`Agent  codex  view native  ${state}`);
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
    expect(term.frame()).toContain("       watch: herdr agent focus x");
    expect(term.frame()[23]?.trim()).toBe("a/enter attach  q quit");
    view.update(model({ state: "done", view: "herdr", focusCommand: ["herdr", "agent", "focus"] }));
    expect(term.frame()[23]?.trim()).toBe("q quit");
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
    expect(term.frame()).toContain("Submit pr opened https://example.com/org/web/pull/7");
    view.close();
  });

  it("truncates long titles to 80 columns", () => {
    const term = fakeTerminal();
    const view = open(term);
    view.update(model({ title: "t".repeat(200) }));
    const item = term.frame().find((line) => line.startsWith("Item"));
    expect(item).toHaveLength(80);
    expect(item?.endsWith("t…")).toBe(true);
    view.close();
  });

  it('shows only a "terminal too small" line below 24 rows', () => {
    const term = fakeTerminal(80, 23);
    const view = open(term);
    view.update(model({}));
    expect(term.frame()).toEqual(["terminal too small: 80x23, need at least 24 rows"]);
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
    expect(term.frame()[23]?.trim()).toBe("↑↓ select  q quit");
    term.press("\x1b[B");
    expect(term.frame()[3]).toBe("> laptop  coding  I-2 e1  codex/pty  done");
    expect(term.frame()).toContain("Item   I-2 (epoch 1, web): add a health check");
    expect(term.frame()).toContain("  two");
    term.press("\x1b[B");
    expect(term.frame()[3]?.startsWith(">")).toBe(true);
    term.press("\x1b[A");
    expect(term.frame()[2]?.startsWith(">")).toBe(true);
    expect(term.frame()).toContain("  one");
    view.close();
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
    expect(term.frame()).toContain(`Submit p ${label} / u push / n none / s skip?`);
    expect(term.frame()[23]?.trim()).toBe(`p ${label}  u push  n none  s skip  q quit`);
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
    expect(term.frame()[23]?.trim()).toBe("↑↓ select  q quit");
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
    expect(term.frame()).toContain("       ready: press a to give the agent this terminal");
    expect(term.frame()[23]?.trim()).toBe("a/enter attach  q quit");
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
      "focusing the agent; from another terminal: herdr agent focus skep-i-1-e1",
    );
    // herdr runs in its own pane: the view keeps the terminal.
    expect(term.rawModes()).toEqual([true]);
    view.close();
  });

  it("a failed focus is shown, with the command to run by hand", async () => {
    const term = fakeTerminal();
    const view = open(term, {
      runFocus: async () => {
        throw new Error("herdr is not running");
      },
    });
    view.update(model({ state: "blocked", view: "herdr", focusCommand: ["herdr", "focus"] }));
    term.press("a");
    await flush();
    expect(term.frame()).toContain(
      "focus failed (herdr is not running); run it yourself: herdr focus",
    );
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
