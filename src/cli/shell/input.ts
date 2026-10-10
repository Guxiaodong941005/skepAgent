/**
 * Key decoding and line editing for the unified shell's input box.
 *
 * TODO(merge feat/unified-tui-shell-ui): temporary stub so `run.ts` compiles before the UI branch
 * lands. Replace with the UI branch's `input.ts` and adapt `run.ts` to its key/action names.
 */

export type ShellKey =
  | { name: "text"; text: string }
  | {
      name:
        | "enter"
        | "backspace"
        | "up"
        | "down"
        | "tab"
        | "escape"
        | "interrupt"
        | "eof"
        | "pageUp"
        | "pageDown"
        | "other";
    };

/**
 * Splits one raw-mode stdin chunk into keys. Escape sequences are consumed whole so their tail
 * bytes never become text; other control bytes are dropped.
 */
export function decodeShellKeys(chunk: Buffer | string): ShellKey[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: ShellKey[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending !== "") keys.push({ name: "text", text: pending });
    pending = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\x1b") {
      flush();
      const next = text[i + 1];
      if (next === "[" || next === "O") {
        let end = i + 2;
        while (end < text.length && !/[@-~]/.test(text[end] as string)) end++;
        const sequence = text.slice(i + 2, end + 1);
        keys.push(csiKey(sequence));
        i = end + 1;
      } else {
        keys.push({ name: "escape" });
        i += 1;
      }
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      flush();
      if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
      else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
      else if (ch === "\t") keys.push({ name: "tab" });
      else if (ch === "\x03") keys.push({ name: "interrupt" });
      else if (ch === "\x04") keys.push({ name: "eof" });
      else keys.push({ name: "other" });
      i += 1;
      continue;
    }
    pending += ch;
    i += 1;
  }
  flush();
  return keys;
}

function csiKey(sequence: string): ShellKey {
  if (sequence === "A") return { name: "up" };
  if (sequence === "B") return { name: "down" };
  if (sequence === "5~") return { name: "pageUp" };
  if (sequence === "6~") return { name: "pageDown" };
  return { name: "other" };
}

/** A non-printable character never enters the buffer (pasted text may carry them). */
export function insertText(buffer: string, text: string): string {
  let out = buffer;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!(code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))) out += char;
  }
  return out;
}

export function backspace(buffer: string): string {
  const chars = [...buffer];
  chars.pop();
  return chars.join("");
}

/** The slash menu query while the first word is still being typed (`/jo` → `jo`). */
export function menuQuery(buffer: string): string | null {
  const match = /^\/(\S*)$/.exec(buffer);
  return match === null ? null : (match[1] ?? "");
}
