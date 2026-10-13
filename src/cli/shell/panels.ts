/**
 * Split-panel layout of the unified shell (docs/plans/tui-scroll-and-herdr-controller.md §7
 * Phase 3, ORCH-5; ARCHITECTURE D34): a main panel with the whole transcript and one panel per
 * peer, in the spirit of herdr's split panes. Everything here is geometry and text over Skep's
 * own entries; panels never host a terminal or parse a vendor TUI (D30).
 */

import type { Span } from "../theme.js";
import { displayWidth, fitSpans, type Line } from "../tui.js";

/** The main panel's id; peer panels use the peer id (`peer-2`), which never equals it. */
export const MAIN_PANEL = "main";

export type ShellLayout = "single" | "split";

/** Terminals at least this wide put the peers in a column right of the main panel. */
export const SIDE_BY_SIDE_COLUMNS = 100;
/** A peer panel needs a title row and two body rows to say anything. */
export const MIN_PANEL_ROWS = 3;
/** Share of the width (side by side) or height (stacked) the main panel keeps. */
const MAIN_SHARE = 0.55;

export interface PanelRect {
  id: string;
  /** First column and body row of the panel, its title row included. */
  left: number;
  top: number;
  width: number;
  /** Rows including the title row. */
  height: number;
}

export interface SplitLayout {
  panels: PanelRect[];
  /** Peers that got no panel for lack of rows; they are reachable with Tab and `/focus`. */
  hidden: string[];
  /** Column of the vertical separator when the peers sit right of the main panel. */
  separator: number | null;
}

/**
 * Places the main panel and as many peer panels as fit in a body of `columns` × `rows`. The
 * focused panel is always placed; `zoomed` gives it the whole body.
 */
export function splitLayout(
  columns: number,
  rows: number,
  peers: readonly string[],
  focus: string,
  zoomed: boolean,
): SplitLayout {
  const full = (id: string): PanelRect => ({ id, left: 0, top: 0, width: columns, height: rows });
  if (zoomed && (focus === MAIN_PANEL || peers.includes(focus))) {
    return { panels: [full(focus)], hidden: [], separator: null };
  }
  if (peers.length === 0 || rows < MIN_PANEL_ROWS * 2) {
    return { panels: [full(MAIN_PANEL)], hidden: [...peers], separator: null };
  }
  const side = columns >= SIDE_BY_SIDE_COLUMNS;
  const mainSize = side
    ? Math.floor(columns * MAIN_SHARE)
    : Math.max(MIN_PANEL_ROWS, Math.floor(rows * (1 - MAIN_SHARE)));
  // Side by side: peers stack in the column right of the separator. Stacked: below the main.
  const area = side ? rows : rows - mainSize;
  const shown = visiblePeers(peers, focus, Math.floor(area / MIN_PANEL_ROWS));
  const main: PanelRect = side
    ? { id: MAIN_PANEL, left: 0, top: 0, width: mainSize, height: rows }
    : { id: MAIN_PANEL, left: 0, top: 0, width: columns, height: mainSize };
  const left = side ? mainSize + 1 : 0;
  const width = side ? columns - mainSize - 1 : columns;
  const base = side ? 0 : mainSize;
  const panels = [main];
  let top = base;
  shown.forEach((id, index) => {
    // The first panels absorb the remainder, so the stack fills the area exactly.
    const height = Math.floor(area / shown.length) + (index < area % shown.length ? 1 : 0);
    panels.push({ id, left, top, width, height });
    top += height;
  });
  return {
    panels,
    hidden: peers.filter((id) => !shown.includes(id)),
    separator: side ? mainSize : null,
  };
}

/** Up to `room` peers in roster order, shifted so the focused peer is among them. */
export function visiblePeers(peers: readonly string[], focus: string, room: number): string[] {
  const count = Math.max(0, Math.min(room, peers.length));
  const at = peers.indexOf(focus);
  const first = at < count ? 0 : at - count + 1;
  return peers.slice(first, first + count);
}

/** The next panel in Tab order (main first, then peers in roster order). */
export function cycleFocus(focus: string, peers: readonly string[], step = 1): string {
  const order = [MAIN_PANEL, ...peers];
  const at = Math.max(0, order.indexOf(focus));
  return order[(at + step + order.length) % order.length] ?? MAIN_PANEL;
}

/**
 * The panel `query` names: `main` (or `master`), a peer id, or a device name that only one peer
 * has. Case-insensitive; null when nothing or several match.
 */
export function resolvePanel(
  query: string,
  peers: readonly { peerId: string; device: string }[],
): string | null {
  const token = query.trim().toLowerCase();
  if (token === MAIN_PANEL || token === "master") return MAIN_PANEL;
  const byId = peers.find((peer) => peer.peerId.toLowerCase() === token);
  if (byId !== undefined) return byId.peerId;
  const byDevice = peers.filter((peer) => peer.device.toLowerCase() === token);
  return byDevice.length === 1 ? (byDevice[0]?.peerId ?? null) : null;
}

/**
 * One line of a peer's progress timeline: phase, counts and the peer's own progress line, which
 * is all that reaches the master today (≤120 characters, redacted; plan §9.6).
 */
export function progressNote(
  state: string,
  progress?: { phase: string; done: number; total: number; percent: number; summary: string },
): string {
  if (progress === undefined) return state;
  const counts =
    progress.total === 0 ? "" : ` ${progress.percent}% ${progress.done}/${progress.total}`;
  const summary = progress.summary === "" ? "" : ` · ${progress.summary}`;
  return `${progress.phase}${counts}${summary}`;
}

function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((width, span) => width + displayWidth(span.text), 0);
}

/** `line` cut or padded to exactly `width` columns. */
export function fitLine(line: Line, width: number): Span[] {
  const spans = fitSpans(typeof line === "string" ? [{ text: line }] : line.spans, width);
  const pad = width - spansWidth(spans);
  return pad > 0 ? [...spans, { text: " ".repeat(pad) }] : spans;
}

/** One body row made of panel cells side by side, each exactly its width. */
export function joinCells(cells: readonly { spans: Span[] }[], separator: Span): Line {
  const spans: Span[] = [];
  cells.forEach((cell, index) => {
    if (index > 0) spans.push(separator);
    spans.push(...cell.spans);
  });
  return { spans };
}
