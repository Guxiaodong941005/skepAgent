/**
 * The shell's transcript: everything a session showed, kept whole (no per-line truncation, no
 * entry-count cap) and laid out into rows at the current width on demand
 * (docs/plans/tui-scroll-and-herdr-controller.md §5.1, §5.3).
 *
 * Retention is the locked decision §9.3: "same session keeps context, max 500K". The transcript
 * lives in memory for the shell session only and holds at most {@link TRANSCRIPT_MAX_CHARS}
 * characters of entry text; past that the oldest entries go and one marker row says so.
 */

import { displayWidth, truncate } from "../tui.js";
import { locateRow, type RowSpace } from "./scroll.js";

export const TRANSCRIPT_MAX_CHARS = 500_000;
export const DROPPED_MARKER = "— earlier output dropped (500K limit) —";

export type TranscriptTone = "info" | "event" | "warn" | "error" | "muted";

export interface TranscriptEntry {
  readonly seq: number;
  readonly tone: TranscriptTone;
  readonly text: string;
  /** Repeated on every wrapped row, e.g. `I-4 │ ` for an agent tail line. */
  readonly gutter?: string;
  readonly marker?: true;
}

/** Continuation rows of a wrapped entry sit this much deeper than its first row. */
const HANGING_INDENT = "    ";
const MARGIN = "  ";

export class Transcript {
  private items: TranscriptEntry[] = [];
  /** Index of the first live entry in `items`; evicted ones are compacted away lazily. */
  private start = 0;
  private nextSeq = 0;
  private chars = 0;
  private droppedEntries = 0;
  /** Bumped whenever entries leave the head, so cached layouts know to rebuild their offsets. */
  private evictions = 0;

  constructor(private readonly maxChars = TRANSCRIPT_MAX_CHARS) {}

  get length(): number {
    return this.items.length - this.start + (this.droppedEntries > 0 ? 1 : 0);
  }

  /** Characters of retained entry text (the marker does not count). */
  get size(): number {
    return this.chars;
  }

  get dropped(): number {
    return this.droppedEntries;
  }

  get evictionCount(): number {
    return this.evictions;
  }

  /** Entry `index`, the drop marker first when entries were evicted. */
  at(index: number): TranscriptEntry | undefined {
    if (this.droppedEntries > 0) {
      if (index === 0) return this.marker();
      return this.items[this.start + index - 1];
    }
    return this.items[this.start + index];
  }

  /** Live entries, without the marker. */
  entries(): TranscriptEntry[] {
    return this.items.slice(this.start);
  }

  firstSeq(): number {
    return this.at(0)?.seq ?? this.nextSeq;
  }

  /** Index of `seq`, clamped into the live range. */
  indexOfSeq(seq: number): number {
    const length = this.length;
    if (length === 0) return 0;
    return Math.min(Math.max(0, seq - this.firstSeq()), length - 1);
  }

  append(text: string, tone: TranscriptTone, gutter?: string): TranscriptEntry {
    const entry: TranscriptEntry = {
      seq: this.nextSeq++,
      tone,
      text,
      ...(gutter === undefined ? {} : { gutter }),
    };
    this.items.push(entry);
    this.chars += text.length;
    this.evict();
    return entry;
  }

  private evict(): void {
    let evicted = false;
    // The newest entry always stays, even alone over the cap: it is what the human just got.
    while (this.chars > this.maxChars && this.items.length - this.start > 1) {
      const gone = this.items[this.start] as TranscriptEntry;
      this.chars -= gone.text.length;
      this.start += 1;
      this.droppedEntries += 1;
      evicted = true;
    }
    if (!evicted) return;
    this.evictions += 1;
    if (this.start > 1024 && this.start * 2 > this.items.length) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }

  /** The marker takes the seq of the last evicted entry, so seqs stay contiguous. */
  private marker(): TranscriptEntry {
    const first = this.items[this.start];
    return {
      seq: (first?.seq ?? this.nextSeq) - 1,
      tone: "muted",
      text: DROPPED_MARKER,
      marker: true,
    };
  }
}

/**
 * The transcript laid out at one width. Wrapped rows are cached per entry and row offsets are
 * extended incrementally on append, so a frame costs O(visible rows + log n) instead of
 * re-wrapping the history (S10). A width change clears the cache; an eviction rebuilds only
 * the offsets.
 */
export class TranscriptRows implements RowSpace {
  private width = -1;
  private evictions = -1;
  private first = 0;
  private readonly cache = new Map<number, string[]>();
  private starts: number[] = [0];

  constructor(private readonly transcript: Transcript) {}

  /** Brings the layout up to date with the transcript at `width` columns. */
  sync(width: number): this {
    const transcript = this.transcript;
    if (width !== this.width) {
      this.width = width;
      this.cache.clear();
      this.starts = [0];
    }
    if (transcript.evictionCount !== this.evictions || transcript.firstSeq() !== this.first) {
      this.evictions = transcript.evictionCount;
      const first = transcript.firstSeq();
      // Rows of evicted entries (and of an old marker seq) are never asked for again.
      for (const seq of this.cache.keys()) if (seq < first + 1) this.cache.delete(seq);
      this.first = first;
      this.starts = [0];
    }
    for (let index = this.starts.length - 1; index < transcript.length; index++) {
      this.starts.push((this.starts[index] ?? 0) + this.rows(index).length);
    }
    return this;
  }

  get totalRows(): number {
    return this.starts.at(-1) ?? 0;
  }

  get entryCount(): number {
    return this.starts.length - 1;
  }

  seqAt(index: number): number {
    return this.transcript.at(index)?.seq ?? this.first;
  }

  indexOfSeq(seq: number): number {
    return this.transcript.indexOfSeq(seq);
  }

  rowStart(index: number): number {
    return this.starts[index] ?? this.totalRows;
  }

  rowCount(index: number): number {
    return this.rowStart(index + 1) - this.rowStart(index);
  }

  /** The wrapped rows of entry `index` at the synced width. */
  rows(index: number): string[] {
    const entry = this.transcript.at(index);
    if (entry === undefined) return [];
    const cached = this.cache.get(entry.seq);
    if (cached !== undefined) return cached;
    const rows = entryRows(entry, this.width);
    this.cache.set(entry.seq, rows);
    return rows;
  }

  /** `count` rows from absolute row `top`, each with its entry. */
  window(top: number, count: number): { entry: TranscriptEntry; text: string }[] {
    const out: { entry: TranscriptEntry; text: string }[] = [];
    if (this.entryCount === 0 || count <= 0) return out;
    let index = locateRow(this, top);
    let row = top - this.rowStart(index);
    while (out.length < count && index < this.entryCount) {
      const entry = this.transcript.at(index) as TranscriptEntry;
      const rows = this.rows(index);
      for (; row < rows.length && out.length < count; row++) {
        out.push({ entry, text: rows[row] as string });
      }
      index += 1;
      row = 0;
    }
    return out;
  }
}

/** Every tone wraps (S1); the gutter of a tail line is repeated on each continuation row. */
export function entryRows(entry: TranscriptEntry, width: number): string[] {
  if (entry.marker === true) return [truncate(`${MARGIN}${entry.text}`, width)];
  const gutter = entry.gutter ?? "";
  const indent = gutter === "" ? `${MARGIN}${HANGING_INDENT}` : `${MARGIN}${gutter}`;
  return wrapLine(`${MARGIN}${gutter}${entry.text}`, width, indent);
}

/**
 * Splits `text` into rows of at most `width` columns, breaking at the last space that fits (or
 * mid-word when none does). Rows after the first start with `indent`. Nothing is dropped.
 */
export function wrapLine(text: string, width: number, indent: string): string[] {
  const clean = truncate(text, Number.MAX_SAFE_INTEGER);
  if (width <= displayWidth(indent) + 1 || displayWidth(clean) <= width) return [clean];
  const rows: string[] = [];
  let rest = clean;
  let prefix = "";
  while (displayWidth(prefix + rest) > width) {
    const room = width - displayWidth(prefix);
    let used = 0;
    let cut = 0;
    let lastSpace = -1;
    const chars = [...rest];
    // Spaces of the leading indent are no break points: a row would come out empty.
    const lead = rest.length - rest.trimStart().length;
    for (let i = 0; i < chars.length; i++) {
      const w = displayWidth(chars[i] ?? "");
      if (used + w > room) break;
      used += w;
      cut = i + 1;
      if (chars[i] === " " && i > lead) lastSpace = i;
    }
    const at = lastSpace > 0 ? lastSpace : Math.max(1, cut);
    rows.push(prefix + chars.slice(0, at).join("").trimEnd());
    rest = chars.slice(at).join("").replace(/^ +/, "");
    prefix = indent;
  }
  if (rest !== "") rows.push(prefix + rest);
  return rows;
}
