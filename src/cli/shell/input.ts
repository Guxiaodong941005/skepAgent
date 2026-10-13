/**
 * Key decoding and line editing for the unified shell's input box.
 *
 * Escape sequences are parsed with their parameters and modifiers (scroll keys arrive as
 * `CSI 5 ; 2 ~`, `CSI 1 ; 5 A`, `SS3 H`, …) and SGR mouse reports as wheel steps
 * (docs/plans/tui-scroll-and-herdr-controller.md §5.2). A sequence split across two `data`
 * chunks is carried to the next chunk instead of turning into stray keys (S9).
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
        | "home"
        | "end"
        /** Shift/Ctrl+arrow: always one row of scrolling, whatever the input shows. */
        | "scrollUp"
        | "scrollDown"
        | "wheelUp"
        | "wheelDown"
        | "other";
    };

/** A held partial sequence is given up (as a plain Esc) after this long without more bytes. */
export const ESCAPE_TIMEOUT_MS = 50;

/**
 * Stateful decoder: {@link push} returns the complete keys of a chunk and holds an unfinished
 * escape sequence for the next one; {@link flush} gives up on it (the caller runs it after
 * {@link ESCAPE_TIMEOUT_MS} of silence, so a lone Esc still works).
 */
export class ShellKeyDecoder {
  private carry = "";

  get pending(): boolean {
    return this.carry !== "";
  }

  push(chunk: Buffer | string): ShellKey[] {
    const text = this.carry + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    this.carry = "";
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
        if (next === undefined) {
          // A chunk that is only Esc is the Esc key; one ending in Esc may be cut mid-sequence.
          if (text.length === 1) keys.push({ name: "escape" });
          else this.carry = ch;
          break;
        }
        if (next === "[" || next === "O") {
          let end = i + 2;
          while (end < text.length && !isFinal(text, end, next)) end++;
          if (end >= text.length) {
            this.carry = text.slice(i);
            break;
          }
          keys.push(
            next === "[" ? csiKey(text.slice(i + 2, end + 1)) : ss3Key(text[end] as string),
          );
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

  /** Gives up on a held partial sequence: it was an Esc key press after all. */
  flush(): ShellKey[] {
    if (this.carry === "") return [];
    this.carry = "";
    return [{ name: "escape" }];
  }
}

/** Stateless decoding of one complete chunk (a trailing partial sequence decodes as Esc). */
export function decodeShellKeys(chunk: Buffer | string): ShellKey[] {
  const decoder = new ShellKeyDecoder();
  return [...decoder.push(chunk), ...decoder.flush()];
}

/** CSI ends at a byte in @..~; SS3 is exactly one byte after `O`. */
function isFinal(text: string, at: number, introducer: string): boolean {
  if (introducer === "O") return true;
  return /[@-~]/.test(text[at] as string);
}

function ss3Key(final: string): ShellKey {
  return finalKey(final, 1);
}

/** `body` is everything after `ESC [`, final byte included. */
function csiKey(body: string): ShellKey {
  const final = body.slice(-1);
  const params = body.slice(0, -1);
  if (params.startsWith("<")) return mouseKey(params.slice(1), final);
  const [first = "", modifier = "1"] = params.split(";");
  const mod = Number.parseInt(modifier, 10) || 1;
  if (final === "~") {
    switch (first) {
      case "5":
        return { name: "pageUp" };
      case "6":
        return { name: "pageDown" };
      case "1":
      case "7":
        return { name: "home" };
      case "4":
      case "8":
        return { name: "end" };
      default:
        return { name: "other" };
    }
  }
  return finalKey(final, mod);
}

/** Arrows, Home and End by their final byte; a modifier (Shift = 2, Ctrl = 5, …) on an arrow scrolls. */
function finalKey(final: string, modifier: number): ShellKey {
  const modified = modifier > 1;
  switch (final) {
    case "A":
      return { name: modified ? "scrollUp" : "up" };
    case "B":
      return { name: modified ? "scrollDown" : "down" };
    case "H":
      return { name: "home" };
    case "F":
      return { name: "end" };
    default:
      return { name: "other" };
  }
}

/** SGR mouse report `CSI < b ; x ; y M|m`: only the wheel means something to the shell. */
function mouseKey(params: string, final: string): ShellKey {
  if (final !== "M") return { name: "other" };
  const button = Number.parseInt(params.split(";")[0] ?? "", 10);
  // Bit 6 marks wheel buttons; shift/meta/ctrl bits (4, 8, 16) do not change the direction.
  if ((button & 0b1100_0011) === 64) return { name: "wheelUp" };
  if ((button & 0b1100_0011) === 65) return { name: "wheelDown" };
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
