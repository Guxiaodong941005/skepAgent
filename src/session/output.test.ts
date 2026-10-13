import { describe, expect, it } from "vitest";
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES, OutputMsgSchema } from "./messages.js";
import { fitBytes, OutputTap, outputFrame, stripTerminal } from "./output.js";

describe("stripTerminal", () => {
  it("drops escapes and controls, keeps what a carriage return drew last", () => {
    expect(stripTerminal("\x1b[1;32mPASS\x1b[0m a.test.ts")).toBe("PASS a.test.ts");
    expect(stripTerminal("\x1b]0;title\x07after")).toBe("after");
    expect(stripTerminal("10%\r50%\r100%\r\ndone")).toBe("100%\ndone");
    expect(stripTerminal("a\x00b\x07c\td")).toBe("abc\td");
  });
});

describe("fitBytes", () => {
  it("cuts on a character boundary and marks the cut", () => {
    expect(fitBytes("short", 10)).toBe("short");
    const cut = fitBytes("中".repeat(100), 20);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(20);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("outputFrame", () => {
  it("keeps the newest lines within 20 lines and 2 KB, counting the rest", () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const frame = outputFrame(many, 3);
    expect(frame.lines).toHaveLength(OUTPUT_MAX_LINES);
    expect(frame.lines.at(-1)).toBe("line 49");
    expect(frame.skipped).toBe(33);
    const wide = Array.from({ length: 10 }, () => "x".repeat(500));
    const fitted = outputFrame(wide);
    expect(Buffer.byteLength(fitted.lines.join("\n"), "utf8")).toBeLessThanOrEqual(
      OUTPUT_MAX_BYTES,
    );
    expect(fitted.skipped).toBe(10 - fitted.lines.length);
    expect(OutputMsgSchema.safeParse({ type: "output", itemId: "I-1", ...fitted }).success).toBe(
      true,
    );
  });

  it("redacts secrets and drops blank lines", () => {
    const secret = `ghp_${"C".repeat(36)}`;
    const frame = outputFrame(["", `token=${secret}`, "  "]);
    expect(frame.lines).toHaveLength(1);
    expect(frame.lines[0]).not.toContain(secret);
  });
});

describe("OutputTap", () => {
  function tap(intervalMs: number) {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: { itemId: string; lines: string[]; skipped: number }[] = [];
    const t = new OutputTap({
      intervalMs,
      monotonicMs: () => now,
      schedule: (ms, fn) => {
        const timer = { at: now + ms, fn };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
      send: (itemId, frame) => sent.push({ itemId, ...frame }),
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    };
    return { t, sent, advance };
  }

  it("sends complete lines at most once per interval", () => {
    const { t, sent, advance } = tap(500);
    t.push("I-1", "one\ntw");
    expect(sent).toEqual([{ itemId: "I-1", lines: ["one"], skipped: 0 }]);
    t.push("I-1", "o\nthree\n");
    expect(sent).toHaveLength(1);
    advance(499);
    expect(sent).toHaveLength(1);
    advance(1);
    expect(sent[1]).toEqual({ itemId: "I-1", lines: ["two", "three"], skipped: 0 });
  });

  it("never sends a partial line, even when the item finishes", () => {
    const { t, sent, advance } = tap(500);
    t.push("I-1", "half a line");
    t.finish("I-1");
    advance(1000);
    expect(sent).toEqual([]);
  });

  it("forgets unsent output when cleared", () => {
    const { t, sent, advance } = tap(500);
    t.push("I-1", "a\n");
    t.push("I-1", "b\n");
    t.clear();
    advance(1000);
    expect(sent.map((frame) => frame.lines)).toEqual([["a"]]);
  });

  it("counts lines that did not fit one frame", () => {
    const { t, sent, advance } = tap(500);
    t.push("I-1", "first\n");
    t.push("I-1", `${Array.from({ length: 25 }, (_, i) => `n${i}`).join("\n")}\n`);
    advance(500);
    expect(sent[1]?.lines).toHaveLength(20);
    expect(sent[1]?.skipped).toBe(5);
  });
});
