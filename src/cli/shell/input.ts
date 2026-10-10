import { type ShellCtx, type SlashCommand, slashMenu } from "./slash.js";

export type InputKey =
  | {
      name:
        | "backspace"
        | "delete"
        | "left"
        | "right"
        | "home"
        | "end"
        | "up"
        | "down"
        | "pageup"
        | "pagedown"
        | "enter"
        | "tab"
        | "escape"
        | "clear"
        | "other";
    }
  | { name: "char"; char: string };

type NamedInputKey = Exclude<InputKey, { name: "char" }>;

export interface InputState {
  draft: string;
  cursor: number;
  menuOpen: boolean;
  menuIndex: number;
}

export type InputAction = { type: "submit"; text: string } | { type: "scroll"; direction: -1 | 1 };

export interface InputUpdate {
  state: InputState;
  action: InputAction | null;
}

export function createInputState(draft = ""): InputState {
  return { draft, cursor: [...draft].length, menuOpen: draft.startsWith("/"), menuIndex: 0 };
}

function safeInput(text: string): string {
  let clean = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\r" || char === "\n" || char === "\t") clean += " ";
    else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) clean += char;
  }
  return clean;
}

export function decodeInputKeys(chunk: Buffer | string): InputKey[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: InputKey[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    if (code === 0x1b) {
      const next = text[index + 1];
      if (next !== "[" && next !== "O") {
        keys.push({ name: "escape" });
        index += 1;
        continue;
      }
      let end = index + 2;
      while (end < text.length) {
        const finalCode = text.charCodeAt(end);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        end += 1;
      }
      const final = text[end];
      const parameter = text.slice(index + 2, end);
      if (final === "~" && parameter === "200") {
        const close = text.indexOf("\x1b[201~", end + 1);
        const pasted = safeInput(text.slice(end + 1, close < 0 ? text.length : close));
        if (pasted !== "") keys.push({ name: "char", char: pasted });
        index = close < 0 ? text.length : close + 6;
        continue;
      }
      const arrows: Record<string, NamedInputKey["name"]> = {
        A: "up",
        B: "down",
        C: "right",
        D: "left",
        H: "home",
        F: "end",
      };
      const numbered: Record<string, NamedInputKey["name"]> = {
        "1": "home",
        "3": "delete",
        "4": "end",
        "5": "pageup",
        "6": "pagedown",
        "7": "home",
        "8": "end",
      };
      const name =
        final === "~" ? numbered[parameter] : final === undefined ? undefined : arrows[final];
      keys.push({ name: name ?? "other" });
      index = end + 1;
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      keys.push({ name: "enter" });
      index += code === 0x0d && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    const controls: Record<number, NamedInputKey["name"]> = {
      1: "home",
      3: "clear",
      5: "end",
      8: "backspace",
      9: "tab",
      21: "clear",
      127: "backspace",
    };
    const control = controls[code];
    if (control !== undefined) keys.push({ name: control });
    else if (code >= 0x20 && !(code >= 0x80 && code < 0xa0)) {
      keys.push({ name: "char", char: String.fromCodePoint(code) });
    }
    index += code > 0xffff ? 2 : 1;
  }
  return keys;
}

export function applyInputKey<Ctx extends ShellCtx>(
  input: InputState,
  key: InputKey,
  commands: readonly SlashCommand<Ctx>[],
  ctx: Ctx,
): InputUpdate {
  const characters = [...input.draft];
  const state = { ...input, cursor: Math.max(0, Math.min(input.cursor, characters.length)) };
  const menu = state.menuOpen ? slashMenu(state.draft, commands, ctx) : null;
  const selected = menu?.commands[state.menuIndex] ?? menu?.commands[0];
  const edited = (): InputUpdate => {
    state.draft = characters.join("");
    state.menuOpen = slashMenu(state.draft, commands, ctx) !== null;
    state.menuIndex = 0;
    return { state, action: null };
  };
  switch (key.name) {
    case "char": {
      const inserted = [...safeInput(key.char)];
      characters.splice(state.cursor, 0, ...inserted);
      state.cursor += inserted.length;
      return edited();
    }
    case "backspace":
      if (state.cursor > 0) characters.splice(--state.cursor, 1);
      return edited();
    case "delete":
      characters.splice(state.cursor, 1);
      return edited();
    case "left":
      state.cursor = Math.max(0, state.cursor - 1);
      break;
    case "right":
      state.cursor = Math.min(characters.length, state.cursor + 1);
      break;
    case "home":
      state.cursor = 0;
      break;
    case "end":
      state.cursor = characters.length;
      break;
    case "escape":
      state.menuOpen = false;
      break;
    case "clear":
      return { state: createInputState(), action: null };
    case "up":
    case "down":
      if (menu?.mode === "commands" && menu.commands.length > 0) {
        const delta = key.name === "up" ? -1 : 1;
        state.menuIndex = (state.menuIndex + delta + menu.commands.length) % menu.commands.length;
      }
      break;
    case "pageup":
    case "pagedown":
      return { state, action: { type: "scroll", direction: key.name === "pageup" ? 1 : -1 } };
    case "enter":
    case "tab":
      if (menu?.mode === "commands" && selected !== undefined) {
        const draft = `/${selected.name}${selected.argsRequired === true ? " " : ""}`;
        return { state: { ...createInputState(draft), menuOpen: false }, action: null };
      }
      if (key.name === "tab") {
        state.menuOpen = false;
        break;
      }
      if (state.draft.trim() !== "") {
        return {
          state: createInputState(),
          action: { type: "submit", text: state.draft.trim() },
        };
      }
      break;
    case "other":
      break;
  }
  return { state, action: null };
}
