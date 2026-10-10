import { describe, expect, it } from "vitest";
import {
  applyInputKey,
  createInputState,
  decodeInputKeys,
  type InputKey,
  type InputState,
} from "./input.js";
import { createSlashCommands, type ShellCtx } from "./slash.js";

const context: ShellCtx = {
  device: "laptop",
  cwd: "~/project",
  role: "coding",
  session: null,
  agent: "codex",
};
const run = () => ({ type: "ok" as const });
const commands = createSlashCommands({
  start: run,
  join: run,
  status: run,
  intent: run,
  help: run,
  quit: run,
  agent: run,
});

function press(input: InputState, key: InputKey) {
  return applyInputKey(input, key, commands, context);
}

function type(text: string, input = createInputState()): InputState {
  return decodeInputKeys(text).reduce((state, key) => press(state, key).state, input);
}

describe("shell key decoder", () => {
  it("keeps case, spaces, punctuation, q and Unicode as input rather than monitor shortcuts", () => {
    expect(decodeInputKeys(Buffer.from("A q/😀"))).toEqual([
      { name: "char", char: "A" },
      { name: "char", char: " " },
      { name: "char", char: "q" },
      { name: "char", char: "/" },
      { name: "char", char: "😀" },
    ]);
  });

  it("decodes editing, menu and scrolling keys, including SS3 arrows", () => {
    expect(
      decodeInputKeys(
        "\x1b[A\x1b[B\x1b[C\x1b[D\x1bOH\x1bOF\x1b[3~\x1b[5~\x1b[6~\t\x7f\x08\x03\x1b",
      ).map(({ name }) => name),
    ).toEqual([
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
      "delete",
      "pageup",
      "pagedown",
      "tab",
      "backspace",
      "backspace",
      "clear",
      "escape",
    ]);
  });

  it("coalesces CRLF and swallows unknown escape sequences and control bytes", () => {
    expect(decodeInputKeys("\r\n\n\x1b[999~\x00\x02\x1b[1;5Ax")).toEqual([
      { name: "enter" },
      { name: "enter" },
      { name: "other" },
      { name: "up" },
      { name: "char", char: "x" },
    ]);
  });

  it("treats bracketed paste as text and never submits embedded newlines", () => {
    expect(decodeInputKeys("\x1b[200~first\n/quit\tlast\x1b[201~")).toEqual([
      { name: "char", char: "first /quit last" },
    ]);
  });
});

describe("pure input editing", () => {
  it("inserts and backspaces without mutating the previous state", () => {
    const initial = createInputState();
    const edited = type("hello", initial);
    expect(initial).toEqual(createInputState());
    expect(press(edited, { name: "backspace" }).state.draft).toBe("hell");
    expect(edited.draft).toBe("hello");
    expect(press(initial, { name: "backspace" }).state.cursor).toBe(0);
  });

  it("moves the cursor and inserts/deletes complete code points", () => {
    let input = type("A😀B");
    expect(input.cursor).toBe(3);
    input = press(input, { name: "left" }).state;
    input = press(input, { name: "backspace" }).state;
    expect(input).toMatchObject({ draft: "AB", cursor: 1 });
    input = press(input, { name: "char", char: "X" }).state;
    input = press(input, { name: "delete" }).state;
    expect(input).toMatchObject({ draft: "AX", cursor: 2 });
    input = press(input, { name: "home" }).state;
    input = press(input, { name: "right" }).state;
    expect(input.cursor).toBe(1);
    input = press(input, { name: "end" }).state;
    expect(input.cursor).toBe(2);
  });

  it("opens the menu on slash, filters as typing continues, and closes on Esc without clearing", () => {
    const input = type("/jo");
    expect(input.menuOpen).toBe(true);
    const closed = press(input, { name: "escape" }).state;
    expect(closed).toMatchObject({ draft: "/jo", menuOpen: false });
    expect(press(closed, { name: "char", char: "i" }).state.menuOpen).toBe(true);
    expect(type("plain text").menuOpen).toBe(false);
  });

  it("lets the menu steal up/down and wrap to commands beyond its six visible rows", () => {
    let input = type("/");
    input = press(input, { name: "up" }).state;
    expect(input.menuIndex).toBe(6);
    input = press(input, { name: "down" }).state;
    expect(input.menuIndex).toBe(0);
    input = press(input, { name: "down" }).state;
    expect(input.menuIndex).toBe(1);
    expect(input.draft).toBe("/");
  });

  it.each(["tab", "enter"] as const)(
    "accepts required arguments with a trailing space using %s, without submitting",
    (name) => {
      const update = press(type("/int"), { name });
      expect(update.state).toMatchObject({ draft: "/intent ", cursor: 8, menuOpen: false });
      expect(update.action).toBeNull();
    },
  );

  it("accepts aliases into canonical commands and does not force optional join arguments", () => {
    expect(press(type("/ex"), { name: "tab" }).state.draft).toBe("/quit");
    const accepted = press(type("/jo"), { name: "tab" });
    expect(accepted.state.draft).toBe("/join");
    expect(press(accepted.state, { name: "enter" }).action).toEqual({
      type: "submit",
      text: "/join",
    });
  });

  it("preserves argument text when closing hints with Tab and submits arguments on Enter", () => {
    const input = type("/join 4821-0937-5520 --host example.invalid:7419");
    expect(input.menuOpen).toBe(true);
    expect(press(input, { name: "tab" }).state.draft).toBe(input.draft);
    const update = press(input, { name: "enter" });
    expect(update.action).toEqual({ type: "submit", text: input.draft });
    expect(update.state).toEqual(createInputState());
  });

  it("submits plain text or an unknown command but not an empty draft", () => {
    expect(press(type("  a goal  "), { name: "enter" }).action).toEqual({
      type: "submit",
      text: "a goal",
    });
    expect(press(type("/missing"), { name: "enter" }).action).toEqual({
      type: "submit",
      text: "/missing",
    });
    expect(press(createInputState(), { name: "enter" }).action).toBeNull();
  });

  it("clears with Ctrl+C instead of quitting, and keeps input focus when paging", () => {
    const input = type("/jo");
    expect(press(input, { name: "clear" })).toEqual({ state: createInputState(), action: null });
    expect(press(input, { name: "pageup" })).toEqual({
      state: input,
      action: { type: "scroll", direction: 1 },
    });
    expect(press(input, { name: "pagedown" }).action).toEqual({ type: "scroll", direction: -1 });
  });
});
