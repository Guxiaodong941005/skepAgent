/**
 * Viewport math shared by the shell's transcript and `skep ui`'s output pane
 * (docs/plans/tui-scroll-and-herdr-controller.md §5.1).
 *
 * A scrolled-up view is pinned to an entry and a row inside it, not to a row count: new output
 * below, a resize, or eviction at the top then keep the same text at the top of the body.
 */

export type ScrollAnchor =
  | { kind: "bottom" }
  | {
      kind: "pinned";
      /** Sequence number of the entry whose row is at the top of the body. */
      seq: number;
      row: number;
    };

export const FOLLOW: ScrollAnchor = { kind: "bottom" };

/** Entries laid out as rows at one width; entries are identified by contiguous `seq`s. */
export interface RowSpace {
  readonly totalRows: number;
  readonly entryCount: number;
  seqAt(index: number): number;
  /** The index of `seq`, clamped into the live range (an evicted seq maps to the first entry). */
  indexOfSeq(seq: number): number;
  /** The first row of entry `index`, counted from the first row of entry 0. */
  rowStart(index: number): number;
  rowCount(index: number): number;
}

export interface ViewWindow {
  /** First row shown (absolute, from the first row of entry 0). */
  top: number;
  above: number;
  below: number;
}

function maxTop(space: RowSpace, height: number): number {
  return Math.max(0, space.totalRows - height);
}

/** The first row an anchor shows in a body of `height` rows. */
export function topRow(anchor: ScrollAnchor, space: RowSpace, height: number): number {
  const max = maxTop(space, height);
  if (anchor.kind === "bottom" || space.entryCount === 0) return max;
  const index = space.indexOfSeq(anchor.seq);
  const evicted = space.seqAt(index) !== anchor.seq;
  // A row index from a wider layout may not exist after a resize; it stays inside its entry.
  const row = evicted ? 0 : Math.min(anchor.row, Math.max(0, space.rowCount(index) - 1));
  return Math.min(max, space.rowStart(index) + row);
}

export function viewWindow(anchor: ScrollAnchor, space: RowSpace, height: number): ViewWindow {
  const top = topRow(anchor, space, height);
  return { top, above: top, below: Math.max(0, space.totalRows - top - height) };
}

/** The anchor that shows row `top` first; the last page follows new output again. */
export function anchorAt(top: number, space: RowSpace, height: number): ScrollAnchor {
  const max = maxTop(space, height);
  if (top >= max || space.entryCount === 0) return FOLLOW;
  const row = Math.max(0, top);
  const index = locateRow(space, row);
  return { kind: "pinned", seq: space.seqAt(index), row: row - space.rowStart(index) };
}

/** Moves the view `rows` rows; positive goes up (older). */
export function scrollAnchor(
  anchor: ScrollAnchor,
  rows: number,
  space: RowSpace,
  height: number,
): ScrollAnchor {
  return anchorAt(topRow(anchor, space, height) - rows, space, height);
}

/** The entry containing absolute row `row` (binary search over row starts). */
export function locateRow(space: RowSpace, row: number): number {
  let low = 0;
  let high = space.entryCount - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (space.rowStart(middle) <= row) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/**
 * A {@link RowSpace} over per-entry row counts, with prefix sums so a lookup is O(log n). Used
 * where entries are rebuilt wholesale (the `skep ui` tail); the shell transcript keeps its own
 * incremental cache.
 */
export class CountedRows implements RowSpace {
  private readonly starts: number[] = [0];

  constructor(
    private readonly counts: readonly number[],
    private readonly firstSeq = 0,
  ) {
    for (const count of counts) this.starts.push((this.starts.at(-1) ?? 0) + count);
  }

  get totalRows(): number {
    return this.starts.at(-1) ?? 0;
  }

  get entryCount(): number {
    return this.counts.length;
  }

  seqAt(index: number): number {
    return this.firstSeq + index;
  }

  indexOfSeq(seq: number): number {
    return Math.min(Math.max(0, seq - this.firstSeq), Math.max(0, this.counts.length - 1));
  }

  rowStart(index: number): number {
    return this.starts[index] ?? this.totalRows;
  }

  rowCount(index: number): number {
    return this.counts[index] ?? 0;
  }
}
