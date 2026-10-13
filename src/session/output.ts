/**
 * Opt-in live agent output (ORCH-6, plan §9.6 and locked §9.9–§9.10, D35). Only complete lines
 * leave the device: a secret split across chunks is redacted once its line is whole, and a
 * partial last line is never sent. Every frame is control-stripped, redacted, at most
 * {@link OUTPUT_MAX_LINES} lines and {@link OUTPUT_MAX_BYTES} bytes, and a peer sends at most one
 * frame per interval (default 500 ms).
 */
import { Redactor } from "../exec/redact.js";
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "./messages.js";

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), DCS/SOS/PM/APC strings, then two-byte escapes.
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Terminal output as plain lines: escape sequences removed, a carriage return keeps only what
 * was drawn last on the line (progress bars), other control characters dropped; tabs stay.
 */
export function stripTerminal(text: string): string {
  return text
    .replace(ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part !== "");
      return (parts[parts.length - 1] ?? "").replace(CONTROLS, "");
    })
    .join("\n");
}

/** Cuts `line` to at most `bytes` UTF-8 bytes on a character boundary, marked with `…`. */
export function fitBytes(line: string, bytes: number): string {
  if (Buffer.byteLength(line, "utf8") <= bytes) return line;
  let out = "";
  let used = Buffer.byteLength("…", "utf8");
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

/**
 * The newest of `lines` that fit one frame, redacted and cleaned again, plus how many were left
 * out. Blank lines are dropped; they carry nothing for a panel.
 */
export function outputFrame(
  lines: readonly string[],
  skipped = 0,
): { lines: string[]; skipped: number } {
  const redactor = new Redactor();
  const clean = lines
    .map((line) =>
      fitBytes(
        redactor.redact(stripTerminal(line).replace(/\n/g, " ")).trimEnd(),
        OUTPUT_MAX_BYTES,
      ),
    )
    .filter((line) => line.trim() !== "");
  const kept: string[] = [];
  let bytes = 0;
  for (let at = clean.length - 1; at >= 0 && kept.length < OUTPUT_MAX_LINES; at -= 1) {
    const line = clean[at] ?? "";
    const size = Buffer.byteLength(line, "utf8") + (kept.length === 0 ? 0 : 1);
    if (bytes + size > OUTPUT_MAX_BYTES) break;
    kept.unshift(line);
    bytes += size;
  }
  return { lines: kept, skipped: skipped + (clean.length - kept.length) };
}

export interface OutputTapOptions {
  intervalMs: number;
  monotonicMs(): number;
  schedule(ms: number, fn: () => void): () => void;
  send(itemId: string, frame: { lines: string[]; skipped: number }): void;
}

interface Pending {
  partial: string;
  lines: string[];
  skipped: number;
}

/**
 * Collects an item's agent output and sends its new complete lines at most once per interval.
 * Lines beyond one frame are counted in `skipped`, not queued: a panel shows the live tail, not
 * a transcript (the transcript stays on the device, D27).
 */
export class OutputTap {
  private readonly pending = new Map<string, Pending>();
  private lastSentMs: number | null = null;
  private cancel: (() => void) | null = null;

  constructor(private readonly o: OutputTapOptions) {}

  push(itemId: string, chunk: string): void {
    const entry = this.pending.get(itemId) ?? { partial: "", lines: [], skipped: 0 };
    this.pending.set(itemId, entry);
    const parts = `${entry.partial}${chunk}`.split("\n");
    entry.partial = parts.pop() ?? "";
    // A line that never ends must not grow without bound; it is sent in pieces.
    if (entry.partial.length > OUTPUT_MAX_BYTES * 4) {
      parts.push(entry.partial);
      entry.partial = "";
    }
    entry.lines.push(...parts);
    // Keep only what one frame can carry; count the rest.
    const overflow = entry.lines.length - OUTPUT_MAX_LINES;
    if (overflow > 0) {
      entry.lines.splice(0, overflow);
      entry.skipped += overflow;
    }
    if (entry.lines.length > 0) this.wake();
  }

  /** The item finished: its unfinished last line is dropped, its complete lines still go. */
  finish(itemId: string): void {
    const entry = this.pending.get(itemId);
    if (entry === undefined) return;
    entry.partial = "";
    if (entry.lines.length === 0 && entry.skipped === 0) this.pending.delete(itemId);
  }

  /** Forget everything not sent yet (sharing turned off, or the session closed). */
  clear(): void {
    this.cancel?.();
    this.cancel = null;
    this.pending.clear();
  }

  private wake(): void {
    if (this.cancel !== null) return;
    const now = this.o.monotonicMs();
    const wait =
      this.lastSentMs === null ? 0 : Math.max(0, this.lastSentMs + this.o.intervalMs - now);
    if (wait === 0) {
      this.flush();
      return;
    }
    this.cancel = this.o.schedule(wait, () => {
      this.cancel = null;
      this.flush();
    });
  }

  /** One frame per interval for the whole peer: the next item waits for the next slot. */
  private flush(): void {
    for (const [itemId, entry] of this.pending) {
      if (entry.lines.length === 0) continue;
      const frame = outputFrame(entry.lines, entry.skipped);
      entry.lines = [];
      entry.skipped = 0;
      if (entry.partial === "") this.pending.delete(itemId);
      if (frame.lines.length === 0) continue;
      this.o.send(itemId, frame);
      this.lastSentMs = this.o.monotonicMs();
      if ([...this.pending.values()].some((rest) => rest.lines.length > 0)) this.wake();
      return;
    }
  }
}
