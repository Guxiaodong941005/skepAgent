import { describe, expect, it } from "vitest";
import { decodeShellKeys, type ShellKey, ShellKeyDecoder } from "./input.js";

const names = (keys: ShellKey[]) => keys.map((key) => (key.name === "text" ? key.text : key.name));

describe("decodeShellKeys (§5.2)", () => {
  it("decodes page, home/end and arrows in every listed encoding", () => {
    expect(names(decodeShellKeys("\x1b[5~\x1b[6~\x1b[5;2~\x1b[6;2~"))).toEqual([
      "pageUp",
      "pageDown",
      "pageUp",
      "pageDown",
    ]);
    expect(
      names(
        decodeShellKeys("\x1b[H\x1b[F\x1bOH\x1bOF\x1b[1~\x1b[4~\x1b[7~\x1b[8~\x1b[1;5H\x1b[1;5F"),
      ),
    ).toEqual(["home", "end", "home", "end", "home", "end", "home", "end", "home", "end"]);
    expect(names(decodeShellKeys("\x1b[A\x1b[B\x1bOA\x1bOB"))).toEqual([
      "up",
      "down",
      "up",
      "down",
    ]);
    expect(names(decodeShellKeys("\x1b[1;2A\x1b[1;2B\x1b[1;5A\x1b[1;5B"))).toEqual([
      "scrollUp",
      "scrollDown",
      "scrollUp",
      "scrollDown",
    ]);
  });

  it("decodes SGR wheel reports and ignores clicks", () => {
    expect(names(decodeShellKeys("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;4M\x1b[<0;3;4m"))).toEqual([
      "wheelUp",
      "wheelDown",
      "other",
      "other",
    ]);
    // Shift held while wheeling still scrolls in the same direction.
    expect(names(decodeShellKeys("\x1b[<68;1;1M"))).toEqual(["wheelUp"]);
  });

  it("keeps text, control keys and a lone Esc as before", () => {
    expect(names(decodeShellKeys("ab\r\x7f\t\x03\x04"))).toEqual([
      "ab",
      "enter",
      "backspace",
      "tab",
      "interrupt",
      "eof",
    ]);
    expect(names(decodeShellKeys("\x1b"))).toEqual(["escape"]);
    expect(names(decodeShellKeys("\x1b[1;5C"))).toEqual(["other"]);
  });
});

describe("ShellKeyDecoder carry buffer (S9)", () => {
  it("completes a sequence split across chunks instead of typing its tail", () => {
    const decoder = new ShellKeyDecoder();
    expect(names(decoder.push("x\x1b["))).toEqual(["x"]);
    expect(decoder.pending).toBe(true);
    expect(names(decoder.push("5~y"))).toEqual(["pageUp", "y"]);
    expect(decoder.pending).toBe(false);
    expect(names(decoder.push("\x1b[<64;1"))).toEqual([]);
    expect(names(decoder.push("0;5M"))).toEqual(["wheelUp"]);
    expect(names(decoder.push("a\x1b"))).toEqual(["a"]);
    expect(names(decoder.push("OA"))).toEqual(["up"]);
  });

  it("a held prefix that never completes becomes Esc on flush", () => {
    const decoder = new ShellKeyDecoder();
    expect(names(decoder.push("a\x1b"))).toEqual(["a"]);
    expect(names(decoder.flush())).toEqual(["escape"]);
    expect(decoder.flush()).toEqual([]);
  });
});
