/**
 * Skep's full-screen control view (D30): one agent at a time, several agents as a list.
 *
 * Dependency-free on purpose: ANSI escapes, raw mode and the alternate screen are all it needs,
 * and a terminal emulator or TUI library would widen the supply chain for a ~24-row screen. The
 * screen is redrawn in full on every change; there is no diffing.
 *
 * It never forwards input to an agent and has no approve key (D29): a blocked agent is answered
 * in the agent's own view, which `a` opens (PTY: this terminal; herdr: its pane).
 */

import { execFileSync } from "node:child_process";
import { type Clock, systemClock } from "../util/clock.js";
import type { JoinView, JoinViewModel, PeerPhase } from "./commands/session.js";
import { bold, fg, PLAIN_THEME, type Role, type Span, type Theme } from "./theme.js";
import { SKEP_VERSION } from "./version.js";

const ESC = "\x1b[";
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const HOME_CLEAR = `${ESC}H${ESC}2J`;
const RESET = `${ESC}0m`;

/** Below this the layout cannot show every section, so only a notice is drawn. */
export const MIN_ROWS = 24;
/** At most this many list rows; the rest of the screen belongs to the tail. */
const MAX_LIST_ROWS = 6;

export type Glyphs = "nerd" | "ascii";
export const TICK_MS = 250;

/** nf-md-bee (Nerd Fonts Material Design). */
export const NF_MD_BEE = "\u{F0FA1}";
/** nf-md-bee-flower — alternate pose for flight. */
export const NF_MD_BEE_FLOWER = "\u{F0FA2}";
/** nf-md-beehive-outline — done marker. */
export const NF_MD_BEEHIVE = "\u{F10CE}";

/**
 * Prefer Nerd Font bee icons when available; otherwise ASCII. Forced by
 * `SKEP_TUI_GLYPHS=nerd|ascii` or legacy `SKEP_TUI_ASCII=1`.
 */
export function detectGlyphs(
  env: NodeJS.ProcessEnv = process.env,
  hasNerdBee: () => boolean = nerdBeeFontInstalled,
): Glyphs {
  const forced = env.SKEP_TUI_GLYPHS?.toLowerCase();
  if (forced === "ascii" || env.SKEP_TUI_ASCII === "1") return "ascii";
  if (forced === "nerd" || forced === "unicode") return "nerd";
  return hasNerdBee() ? "nerd" : "ascii";
}

/** True when fontconfig can resolve a face covering nf-md-bee (U+F0FA1). */
export function nerdBeeFontInstalled(): boolean {
  try {
    const out = execFileSync("fc-list", [":charset=0xf0fa1"], {
      encoding: "utf8",
      timeout: 800,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function beeLane(phase: PeerPhase, beat: number, glyphs: Glyphs): string {
  if (glyphs === "nerd") {
    const bee = NF_MD_BEE;
    const beeAlt = beat % 2 === 0 ? NF_MD_BEE : NF_MD_BEE_FLOWER;
    if (phase === "working") {
      // Ping-pong flight; beeAlt flips nf-md-bee / nf-md-bee-flower each beat (wing flap).
      const frames = [`${beeAlt}  `, ` ${beeAlt} `, `  ${beeAlt}`, ` ${beeAlt} `] as const;
      return frames[beat % 4] ?? frames[0];
    }
    if (phase === "blocked") return beat % 4 < 2 ? `${bee}! ` : `${bee}  `;
    if (phase === "done") return `${NF_MD_BEEHIVE}  `;
    return ".   ";
  }
  // Colored-ASCII fallback (no ANSI — printable() strips controls): dart + letters.
  if (phase === "working") {
    const frames = ["~b> ", " ~b>", " >~b", " ~b>"] as const;
    return frames[beat % 4] ?? frames[0];
  }
  if (phase === "blocked") return beat % 4 < 2 ? "b!> " : "b>  ";
  if (phase === "done") return "ok  ";
  return ".   ";
}

export function progressBar(percent: number, glyphs: Glyphs): string {
  const { filled, empty } = progressBarParts(percent, glyphs);
  return filled + empty;
}

/** The bar's filled and empty cells apart, so each can take its own role. */
export function progressBarParts(
  percent: number,
  glyphs: Glyphs,
): { filled: string; empty: string } {
  const bounded = Math.max(0, Math.min(100, percent));
  const cells = bounded === 100 ? 8 : Math.min(7, Math.round(bounded / 12.5));
  const full = glyphs === "nerd" ? "█" : "#";
  const empty = glyphs === "nerd" ? "░" : ".";
  return { filled: full.repeat(cells), empty: empty.repeat(8 - cells) };
}

export function charWidth(cp: number): number {
  // Emoji + Nerd Fonts Material Design PUA (often double-width in terminals).
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2;
  if (cp >= 0xf0000 && cp <= 0xf1af0) return 2;
  return 1;
}

function displayWidth(text: string): number {
  return [...text].reduce((width, char) => width + charWidth(char.codePointAt(0) ?? 0), 0);
}

// ---------------------------------------------------------------------------------------------
// Terminal I/O.

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TtyOutput {
  isTTY?: boolean;
  write(text: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

type ProcessEvent = "SIGINT" | "SIGTERM" | "exit";

/** Where terminal-restoring handlers are installed; `process` in production, a fake in tests. */
export interface ProcessHooks {
  on(event: ProcessEvent, listener: () => void): unknown;
  off(event: ProcessEvent, listener: () => void): unknown;
}

export type Key =
  | { name: "up" | "down" | "enter" | "quit" }
  | { name: "char"; char: string }
  | { name: "other" };

/**
 * Splits one stdin chunk into keys. Raw mode delivers Ctrl-C as a byte rather than a signal, so it
 * decodes to `quit` like `q`. Unknown escape sequences are swallowed whole so their tail bytes are
 * never read as letters.
 */
export function decodeKeys(chunk: Buffer | string): Key[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[" || next === "O") {
        // CSI/SS3: parameter bytes, then one final byte in @..~.
        let end = i + 2;
        while (end < text.length && !/[@-~]/.test(text[end] as string)) end++;
        const final = text[end];
        keys.push(
          final === "A" ? { name: "up" } : final === "B" ? { name: "down" } : { name: "other" },
        );
        i = end + 1;
      } else {
        keys.push({ name: "other" });
        i += 1;
      }
      continue;
    }
    if (ch === "\x03" || ch === "q") keys.push({ name: "quit" });
    else if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (/^[a-z]$/i.test(ch)) keys.push({ name: "char", char: ch.toLowerCase() });
    else keys.push({ name: "other" });
    i += 1;
  }
  return keys;
}

/** Drops control characters so text from the wire can never move the cursor or restyle. */
function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\t") out += " ";
    else if (!(code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))) out += char;
  }
  return out;
}

/** Cuts `text` to `width` display columns, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  const clean = printable(text);
  if (displayWidth(clean) <= width) return clean;
  if (width <= 0) return "";
  let used = 0;
  let out = "";
  for (const char of clean) {
    const columns = charWidth(char.codePointAt(0) ?? 0);
    if (used + columns > width - 1) break;
    out += char;
    used += columns;
  }
  return `${out}…`;
}

/**
 * Cuts styled spans to `width` display columns as {@link truncate} cuts text: the controls of
 * every span are stripped first, and the ellipsis keeps the style of the span it ends.
 */
function fitSpans(spans: readonly Span[], width: number): Span[] {
  const clean = spans.map((span) => ({ ...span, text: printable(span.text) }));
  if (spansWidth(clean) <= width) return clean;
  if (width <= 0) return [];
  const out: Span[] = [];
  let used = 0;
  for (const span of clean) {
    let text = "";
    for (const char of span.text) {
      const columns = charWidth(char.codePointAt(0) ?? 0);
      if (used + columns > width - 1) {
        out.push({ ...span, text: `${text}…` });
        return out;
      }
      text += char;
      used += columns;
    }
    out.push({ ...span, text });
  }
  return out;
}

function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((width, span) => width + displayWidth(printable(span.text)), 0);
}

/**
 * One screen row. A plain string has no style. Span lines carry roles, never escapes: only the
 * {@link Screen} turns roles into SGR through its theme, so frames read the same at every color
 * level. `selected` is the single inverse row (§2.4); it and `fill` are padded to the width.
 */
export type Line = string | { spans: Span[]; selected?: boolean; fill?: boolean };

export interface ScreenIo {
  stdin: TtyInput;
  stdout: TtyOutput;
  /** Fixed size (tests); otherwise read from `stdout` on every frame. */
  columns?: number;
  rows?: number;
}

/**
 * Owns the terminal between `start()` and `close()`. Every exit path — quit, a thrown error, a
 * signal, process exit, `suspend()` — goes through {@link restore}, so the user's shell is never
 * left in raw mode on the alternate screen.
 */
export class Screen {
  private active = false;
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    for (const key of decodeKeys(chunk)) {
      if (!this.active) return;
      this.handlers.onKey(key);
    }
  };
  private readonly onResize = (): void => this.handlers.onResize?.();
  private readonly onSignal = (): void => {
    this.close();
    this.handlers.onSignal?.();
  };
  private readonly onExit = (): void => this.close();

  constructor(
    private readonly io: ScreenIo,
    private readonly handlers: {
      onKey(key: Key): void;
      onResize?(): void;
      /** After the terminal was restored because of SIGINT/SIGTERM. */
      onSignal?(): void;
    },
    private readonly hooks: ProcessHooks = process,
    private readonly theme: Theme = PLAIN_THEME,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  size(): { columns: number; rows: number } {
    return {
      columns: this.io.columns ?? this.io.stdout.columns ?? 80,
      rows: this.io.rows ?? this.io.stdout.rows ?? 24,
    };
  }

  start(): void {
    if (this.closed) throw new Error("the screen was closed and cannot be restarted");
    this.hooks.on("SIGINT", this.onSignal);
    this.hooks.on("SIGTERM", this.onSignal);
    this.hooks.on("exit", this.onExit);
    this.io.stdout.on?.("resize", this.onResize);
    this.enter();
  }

  /** Full redraw. A throw (e.g. a broken stdout) restores the terminal before it propagates. */
  draw(lines: Line[]): void {
    if (!this.active) return;
    try {
      const { columns, rows } = this.size();
      const body = lines.slice(0, rows).map((line) => this.paint(line, columns));
      this.io.stdout.write(`${HOME_CLEAR}${body.join("\r\n")}`);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Every styled span ends with RESET, so a cut line never leaks its style into the next. */
  private paint(line: Line, columns: number): string {
    if (typeof line === "string") return truncate(line, columns);
    const spans = fitSpans(line.spans, columns);
    const padded = line.selected === true || line.fill === true;
    const pad = padded ? " ".repeat(Math.max(0, columns - spansWidth(spans))) : "";
    if (line.selected === true) {
      // Roles are dropped under the highlight: inverse swaps fg and bg, so a colored span would
      // become a colored block, and the selection must look the same at every color level.
      const text = spans.map((span) => span.text).join("");
      return `${this.theme.sgr({ inverse: true })}${text}${pad}${RESET}`;
    }
    const body = spans.map((span) => {
      const code = span.text === "" ? "" : this.theme.sgr(span);
      return code === "" ? span.text : `${code}${span.text}${RESET}`;
    });
    return `${body.join("")}${pad}`;
  }

  /** Gives the terminal back (a PTY agent runs in it) until {@link resume}. */
  suspend(): void {
    if (!this.active) return;
    this.restore();
  }

  resume(): void {
    if (this.active || this.closed) return;
    this.enter();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hooks.off("SIGINT", this.onSignal);
    this.hooks.off("SIGTERM", this.onSignal);
    this.hooks.off("exit", this.onExit);
    this.io.stdout.off?.("resize", this.onResize);
    if (this.active) this.restore();
  }

  private enter(): void {
    const { stdin, stdout } = this.io;
    if (stdin.isTTY === true) stdin.setRawMode?.(true);
    stdin.on("data", this.onData);
    stdin.resume();
    stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    this.active = true;
  }

  private restore(): void {
    const { stdin, stdout } = this.io;
    this.active = false;
    // Each step runs even when an earlier one throws: half a restore is worse than none.
    const steps = [
      () => stdin.off("data", this.onData),
      () => stdin.pause(),
      () => {
        if (stdin.isTTY === true) stdin.setRawMode?.(false);
      },
      () => stdout.write(`${RESET}${CURSOR_SHOW}${ALT_SCREEN_OFF}`),
    ];
    const errors: unknown[] = [];
    for (const step of steps) {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "could not fully restore the terminal");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What the screen shows.

export type SubmitChoice = "pr" | "mr" | "push" | "none" | null;
export type CodeHostKind = "github" | "gitlab" | "git";

export interface TuiPeer {
  peerId: string;
  device: string;
  role: string;
  state: string;
  progress?: JoinViewModel["peers"][number]["progress"];
}

/** One item, and its agent when this device runs it. A master sees items without agents. */
export interface TuiEntry {
  key: string;
  /** The peer the item is assigned to. */
  peerId: string;
  item: NonNullable<JoinViewModel["item"]>;
  /** The item's protocol state as the master tracks it, when there is no local agent. */
  itemState?: string;
  agent: JoinViewModel["agent"];
  /** Already redacted and control-stripped by the producer. */
  tail: string;
  submit?: JoinViewModel["submit"];
}

export interface TuiSnapshot {
  header: { session: string; device: string; role: string };
  peers: TuiPeer[];
  entries: TuiEntry[];
}

type Row = { spans: Span[]; entry: string | null };

/** `error` messages are prefixed `! ` and use the error role; `info` uses secondary. */
export type MessageTone = "info" | "error";

/** Glyph tokens (§3.4). Ascii mode avoids East-Asian ambiguous-width chrome (`─`, `·`). */
function chrome(glyphs: Glyphs): { rule: string; sep: string; icon: string; enter: string } {
  return glyphs === "nerd"
    ? { rule: "─", sep: " · ", icon: `${NF_MD_BEEHIVE} `, enter: "⏎" }
    : { rule: "-", sep: " | ", icon: "", enter: "enter" };
}

/**
 * The one place states get colors (§3.3): every peer phase, agent state, item state and submit
 * state maps to a role, and the word itself is always kept, so no state is told by color alone.
 */
const STATE_ROLES: Readonly<Record<string, Role>> = {
  idle: "on-surface-variant",
  joined: "on-surface-variant",
  starting: "on-surface-variant",
  planned: "on-surface-variant",
  pending: "on-surface-variant",
  skipped: "on-surface-variant",
  local: "on-surface-variant",
  working: "primary",
  running: "primary",
  claimed: "primary",
  blocked: "warning",
  done: "success",
  opened: "success",
  pushed: "success",
  failed: "error",
  left: "error",
};

export function chip(state: string): Span {
  return {
    text: state,
    role: Object.hasOwn(STATE_ROLES, state) ? STATE_ROLES[state] : "on-surface",
  };
}

function muted(text: string): Line {
  return { spans: [fg("on-surface-variant", text)] };
}

/** `text` cut and padded to exactly `width` display columns, for aligned columns. */
function column(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)));
}

/** `── LABEL ───── right ─`, exactly `columns` wide; the right label goes first when tight. */
function rule(label: string, right: string, columns: number, glyphs: Glyphs): Line {
  const g = chrome(glyphs);
  const fixed = 4 + label.length;
  const end = right === "" ? 0 : displayWidth(printable(right)) + 3;
  const keep = end > 0 && columns - fixed - end >= 4;
  const fill = Math.max(1, columns - fixed - (keep ? end : 0));
  return {
    spans: [
      fg("outline", `${g.rule}${g.rule} `),
      bold(label, "on-surface-variant"),
      fg("outline", ` ${g.rule.repeat(fill)}`),
      ...(keep ? [fg("on-surface-variant", ` ${right} `), fg("outline", g.rule)] : []),
    ],
  };
}

/**
 * State and frame layout without any I/O, so frames can be asserted line by line.
 * {@link TuiJoinView} and `skep ui` drive it through a {@link Screen}. It names roles only; the
 * screen's theme decides what they look like (docs/plans/tui-material-redesign.md §2).
 */
export class TuiModel {
  snapshot: TuiSnapshot = {
    header: { session: "-", device: "-", role: "-" },
    peers: [],
    entries: [],
  };
  selected: string | null = null;
  /** Items whose submit choice is waiting on the human. */
  readonly pendingSubmit = new Set<string>();
  /** The PTY item waiting for `a` to take the terminal. */
  pendingAttach: string | null = null;
  host: CodeHostKind = "github";
  message: { text: string; tone: MessageTone } | null = null;
  beat = 0;
  glyphs: Glyphs = "nerd";
  /** Shown at the right of the header; null hides it. */
  version: string | null = SKEP_VERSION;

  animating(): boolean {
    return this.snapshot.peers.some(
      (peer) => peer.progress?.phase === "working" || peer.progress?.phase === "blocked",
    );
  }

  set(snapshot: TuiSnapshot): void {
    this.snapshot = snapshot;
    if (this.selected === null || !snapshot.entries.some((e) => e.key === this.selected)) {
      this.selected = snapshot.entries[0]?.key ?? null;
    }
  }

  current(): TuiEntry | null {
    return this.snapshot.entries.find((e) => e.key === this.selected) ?? null;
  }

  move(delta: number): void {
    const { entries } = this.snapshot;
    if (entries.length === 0) return;
    const at = entries.findIndex((e) => e.key === this.selected);
    const next = Math.min(entries.length - 1, Math.max(0, at + delta));
    this.selected = entries[next]?.key ?? this.selected;
  }

  /** What `a`/Enter would do for the selected entry, or null when attaching is not possible. */
  attachKind(entry: TuiEntry | null = this.current()): "pty" | "herdr" | null {
    if (entry === null || entry.agent === null) return null;
    if (entry.agent.view === "pty" && this.pendingAttach === entry.key) return "pty";
    const live = entry.agent.state === "running" || entry.agent.state === "blocked";
    if (entry.agent.view === "herdr" && live && entry.agent.focusCommand !== undefined) {
      return "herdr";
    }
    return null;
  }

  prLabel(): "pr" | "mr" {
    return this.host === "gitlab" ? "mr" : "pr";
  }

  /** Only the keys that do something right now; `pending` marks a choice that waits on the human. */
  footerKeys(): { key: string; label: string; pending?: boolean }[] {
    const keys: { key: string; label: string; pending?: boolean }[] = [];
    const entry = this.current();
    if (this.snapshot.entries.length > 1) keys.push({ key: "↑↓", label: "select" });
    if (this.attachKind(entry) !== null) {
      keys.push({ key: `a/${chrome(this.glyphs).enter}`, label: "attach" });
    }
    if (entry !== null && this.pendingSubmit.has(entry.key)) {
      keys.push(
        { key: "p", label: this.prLabel(), pending: true },
        { key: "u", label: "push", pending: true },
        { key: "n", label: "none", pending: true },
        { key: "s", label: "skip", pending: true },
      );
    }
    keys.push({ key: "q", label: "quit" });
    return keys;
  }

  frame(columns: number, rows: number): Line[] {
    if (rows < MIN_ROWS) {
      return [
        {
          spans: [
            fg(
              "error",
              `terminal too small: ${columns}x${rows}; resize to at least ${MIN_ROWS} rows`,
            ),
          ],
        },
      ];
    }
    const g = chrome(this.glyphs);
    const lines: Line[] = [
      this.header(columns),
      rule("PEERS", this.peerCounts(), columns, this.glyphs),
    ];

    const list = this.listRows(columns);
    if (list.length === 0) {
      lines.push(muted("  Waiting for peers: run skep session join on another device"));
    }
    const at = list.findIndex((r) => r.entry !== null && r.entry === this.selected);
    const start = Math.max(0, Math.min(at - MAX_LIST_ROWS + 1, list.length - MAX_LIST_ROWS));
    for (const row of list.slice(start, start + MAX_LIST_ROWS)) {
      const mark = row.entry !== null && row.entry === this.selected;
      lines.push(
        mark
          ? { spans: [{ text: "> " }, ...row.spans], selected: true }
          : { spans: [{ text: "  " }, ...row.spans] },
      );
    }
    if (list.length > MAX_LIST_ROWS) {
      lines.push(muted(`  +${list.length - MAX_LIST_ROWS} more${g.sep}↑↓ to scroll`));
    }

    const entry = this.current();
    const itemLabel = entry === null ? "" : `${entry.item.itemId}${g.sep}epoch ${entry.item.epoch}`;
    lines.push(rule("ITEM", itemLabel, columns, this.glyphs));
    lines.push(...this.detail(entry));
    if (this.message !== null) {
      const { text, tone } = this.message;
      lines.push({
        spans: [tone === "error" ? fg("error", `  ! ${text}`) : fg("secondary", `  ${text}`)],
      });
    }

    const tail = entry === null || entry.tail === "" ? [] : entry.tail.split("\n");
    // The OUTPUT rule and the footer take one row each.
    const room = rows - lines.length - 2;
    const shown = room > 0 ? tail.slice(-room) : [];
    const hidden = shown.length < tail.length ? `last ${shown.length} of ${tail.length}` : "";
    lines.push(rule("OUTPUT", hidden, columns, this.glyphs));
    if (tail.length === 0) lines.push(muted("    No output yet"));
    lines.push(...shown.map((line) => `    ${line}`));
    while (lines.length < rows - 1) lines.push("");
    lines.length = rows - 1;
    lines.push(this.footer(columns));
    return lines;
  }

  /** Brand, then context; the version goes first and then the role when the width is short. */
  private header(columns: number): Line {
    const { header } = this.snapshot;
    const g = chrome(this.glyphs);
    const brand: Span[] = [
      { text: " " },
      ...(g.icon === "" ? [] : [fg("primary", g.icon)]),
      bold("skep", "primary"),
      { text: "   " },
    ];
    const fields: Span[][] = [
      [fg("on-surface-variant", "session "), { text: header.session }],
      [fg("on-surface-variant", "device "), { text: header.device }],
      [fg("on-surface-variant", "role "), { text: header.role }],
    ];
    const left = (count: number): Span[] => [
      ...brand,
      ...fields.slice(0, count).flatMap((f, i) => (i === 0 ? f : [fg("outline", g.sep), ...f])),
    ];
    const full = left(fields.length);
    if (this.version !== null) {
      const version = `v${this.version}`;
      const gap = columns - spansWidth(full) - version.length - 1;
      if (gap >= 2) {
        return { spans: [...full, { text: " ".repeat(gap) }, fg("outline", version)] };
      }
    }
    return { spans: spansWidth(full) <= columns ? full : left(fields.length - 1) };
  }

  private peerCounts(): string {
    const { peers } = this.snapshot;
    if (peers.length === 0) return "";
    const g = chrome(this.glyphs);
    const parts = [`${peers.length} ${peers.length === 1 ? "peer" : "peers"}`];
    for (const phase of ["working", "blocked"] as const) {
      const count = peers.filter((p) => p.progress?.phase === phase).length;
      if (count > 0) parts.push(`${count} ${phase}`);
    }
    return parts.join(g.sep);
  }

  private listRows(columns: number): Row[] {
    const { peers, entries } = this.snapshot;
    const known = new Set(peers.map((p) => p.peerId));
    const orphans = entries.filter((e) => !known.has(e.peerId));
    // Aligned columns (§2.3): as wide as the widest name, capped so the strip keeps its room.
    const widest = (names: string[], cap: number) =>
      Math.min(cap, Math.max(0, ...names.map((n) => displayWidth(printable(n)))));
    const deviceWidth = widest(
      [...peers.map((p) => p.device), ...orphans.map((e) => e.peerId)],
      12,
    );
    const roleWidth = widest(
      peers.map((p) => p.role),
      10,
    );
    const who = (device: string, role: string): Span[] => [
      { text: `${column(device, deviceWidth)}  ` },
      fg("on-surface-variant", `${column(role, roleWidth)}  `),
    ];
    const out: Row[] = [];
    for (const peer of peers) {
      const own = entries.filter((e) => e.peerId === peer.peerId);
      const progress = peer.progress;
      if (progress !== undefined) {
        out.push({
          spans: [
            ...who(peer.device, peer.role),
            ...this.strip(progress, columns, deviceWidth + roleWidth + 4),
          ],
          entry: null,
        });
      } else if (own.length === 0) {
        out.push({ spans: [...who(peer.device, peer.role), chip(peer.state)], entry: null });
      }
      for (const entry of own) {
        out.push({
          spans: [...who(peer.device, peer.role), ...entrySpans(entry)],
          entry: entry.key,
        });
      }
    }
    for (const entry of orphans) {
      out.push({ spans: [...who(entry.peerId, ""), ...entrySpans(entry)], entry: entry.key });
    }
    return out;
  }

  /**
   * `lane [bar] pct% done/total phase summary`. Narrow screens shed `done/total` below 70
   * columns and the bar below 60 (§2.3); the summary is last and takes what room is left.
   */
  private strip(progress: NonNullable<TuiPeer["progress"]>, columns: number, used: number): Span[] {
    const phaseRole = chip(progress.phase).role ?? "on-surface";
    const failed = progress.phase === "done" && progress.failed > 0;
    const spans: Span[] = [
      fg(phaseRole, beeLane(progress.phase, this.beat, this.glyphs)),
      { text: "  " },
    ];
    if (columns >= 60) {
      const bar = progressBarParts(progress.percent, this.glyphs);
      spans.push(
        fg("outline", "["),
        fg(failed ? "error" : "primary", bar.filled),
        fg("outline", bar.empty),
        fg("outline", "]"),
        { text: " " },
      );
    }
    spans.push(bold(`${String(progress.percent).padStart(3)}%`));
    if (columns >= 70) {
      spans.push(fg("on-surface-variant", `  ${progress.done}/${progress.total}`));
    }
    spans.push({ text: "  " }, chip(progress.phase));
    if (failed) spans.push(fg("error", ` (${progress.failed} failed)`));
    const summary = printable(progress.summary);
    // Two columns for the "> " mark, two for the gap; a summary cut below 6 columns says nothing.
    if (summary !== "" && columns - 2 - used - spansWidth(spans) - 2 >= 6) {
      spans.push({ text: `  ${summary}` });
    }
    return spans;
  }

  private detail(entry: TuiEntry | null): Line[] {
    const g = chrome(this.glyphs);
    if (entry === null) {
      return [
        muted(
          this.snapshot.header.role === "master"
            ? "  No items yet"
            : "  No item yet: the master has not assigned work to this device",
        ),
      ];
    }
    const label = (name: string): Span => fg("on-surface-variant", `  ${name.padEnd(6)}  `);
    const indent: Span = { text: " ".repeat(10) };
    const sep = fg("outline", g.sep);
    const { item, agent } = entry;
    const lines: Line[] = [
      { spans: [label("Item"), { text: `${item.itemId} (${item.repo})  ${item.title}` }] },
    ];
    if (agent === null) {
      lines.push({
        spans: [
          label("Agent"),
          { text: "runs on its device" },
          sep,
          fg("on-surface-variant", "item "),
          chip(entry.itemState ?? "unknown"),
        ],
      });
    } else {
      lines.push({
        spans: [
          label("Agent"),
          fg("tertiary", agent.cli),
          sep,
          fg("on-surface-variant", "view "),
          { text: agent.view },
          sep,
          chip(agent.state),
        ],
      });
      if (agent.state === "blocked") {
        lines.push({
          spans: [indent, fg("warning", "! answer in the agent's own view (press a)")],
        });
      }
      if (this.pendingAttach === entry.key) {
        lines.push({
          spans: [indent, fg("primary", "ready: press a to give the agent this terminal")],
        });
      }
      if (agent.view === "herdr" && agent.focusCommand !== undefined) {
        lines.push({
          spans: [
            indent,
            fg("on-surface-variant", "watch: "),
            { text: agent.focusCommand.join(" ") },
          ],
        });
      }
    }
    const outcome = entry.submit?.outcome;
    if (this.pendingSubmit.has(entry.key)) {
      lines.push({
        spans: [label("Submit"), fg("warning", `p ${this.prLabel()} / u push / n none / s skip?`)],
      });
    } else if (outcome !== undefined) {
      lines.push({
        spans: [
          label("Submit"),
          { text: `${outcome.method} ` },
          chip(outcome.state),
          ...(outcome.url === undefined ? [] : [{ text: ` ${outcome.url}` }]),
        ],
      });
    } else if (entry.submit !== undefined) {
      lines.push({
        spans: [
          label("Submit"),
          fg("on-surface-variant", "policy "),
          { text: entry.submit.policy },
        ],
      });
    }
    return lines;
  }

  /** Keys that act now on the left, the selection's position on the right (§2.5). */
  private footer(columns: number): Line {
    const g = chrome(this.glyphs);
    const spans: Span[] = [{ text: " " }];
    this.footerKeys().forEach(({ key, label, pending }, i) => {
      if (i > 0) spans.push(fg("outline", g.sep));
      spans.push(bold(key, pending === true ? "warning" : "primary"));
      spans.push(fg("on-surface-variant", ` ${label}`));
    });
    const { entries } = this.snapshot;
    if (entries.length > 1) {
      const at = entries.findIndex((e) => e.key === this.selected);
      const position = `${at + 1}/${entries.length}`;
      const gap = columns - spansWidth(spans) - position.length - 1;
      if (gap >= 2) spans.push({ text: " ".repeat(gap) }, fg("on-surface-variant", position));
    }
    return { spans, fill: true };
  }
}

function entrySpans(entry: TuiEntry): Span[] {
  const { item, agent } = entry;
  const id: Span = { text: `${item.itemId} e${item.epoch}  ` };
  if (agent === null) return [id, chip(entry.itemState ?? "unknown")];
  return [id, fg("tertiary", `${agent.cli}/${agent.view}`), { text: "  " }, chip(agent.state)];
}

// ---------------------------------------------------------------------------------------------
// The `JoinView` for `skep session join --ui`.

export interface TuiOptions {
  io: ScreenIo;
  hooks?: ProcessHooks;
  /** The device's code host; GitLab offers `mr` in place of `pr`. Awaited before a choice. */
  host?: CodeHostKind | Promise<CodeHostKind>;
  /** Runs a herdr `focus` command (argv, never a shell string). */
  runFocus?(argv: readonly string[]): Promise<void>;
  /** The human pressed `q`/Ctrl-C or a signal arrived; the terminal is already restored. */
  onQuit?(reason: "key" | "signal"): void;
  session?: string;
  clock?: Clock;
  animate?: boolean;
  glyphs?: Glyphs;
  /** Color level and palette (default: no color, attributes only). */
  theme?: Theme;
}

/** Shared screen + model + key handling for both the join view and `skep ui`. */
export class Tui {
  readonly model = new TuiModel();
  readonly screen: Screen;
  private readonly submitWaiters = new Map<string, (choice: SubmitChoice) => void>();
  private attachWaiter: (() => void) | null = null;
  private ticker: AbortController | null = null;
  /** Settles once the code host is known (or could not be read; then `pr` is offered). */
  readonly hostReady: Promise<void>;

  constructor(private readonly opts: TuiOptions) {
    this.model.glyphs = opts.glyphs ?? "nerd";
    this.screen = new Screen(
      opts.io,
      {
        onKey: (key) => this.guard(() => this.onKey(key)),
        onResize: () => this.guard(() => this.render()),
        onSignal: () => this.quit("signal"),
      },
      opts.hooks,
      opts.theme,
    );
    const host = opts.host ?? "github";
    if (typeof host === "string") {
      this.model.host = host;
      this.hostReady = Promise.resolve();
    } else {
      this.hostReady = host.then(
        (value) => {
          this.model.host = value;
        },
        (error: unknown) => {
          this.model.message = {
            text: `could not read the code host (${errorMessage(error)}); offering pr`,
            tone: "error",
          };
        },
      );
    }
  }

  start(): void {
    this.screen.start();
    this.render();
  }

  render(): void {
    const { columns, rows } = this.screen.size();
    this.screen.draw(this.model.frame(columns, rows));
    this.maybeTick();
  }

  /** Runs `fn`; on a throw the terminal is restored before the error propagates. */
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Resolves with the human's choice for `key`; null when they skip or the view closes. */
  askSubmit(key: string): Promise<SubmitChoice> {
    if (this.screen.isClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.submitWaiters.set(key, resolve);
      this.model.pendingSubmit.add(key);
      // Bring the question on screen unless the human is already answering another one.
      if (!this.model.pendingSubmit.has(this.model.selected ?? "")) this.model.selected = key;
      this.render();
    });
  }

  /** Resolves once the human pressed `a` and the screen gave the terminal away. */
  waitForAttach(key: string): Promise<void> {
    if (this.screen.isClosed) return Promise.resolve();
    return new Promise((resolve) => {
      this.attachWaiter = resolve;
      this.model.pendingAttach = key;
      this.model.selected = key;
      this.render();
    });
  }

  resume(): void {
    this.screen.resume();
    this.render();
  }

  close(): void {
    this.ticker?.abort();
    this.screen.close();
    for (const [key, resolve] of this.submitWaiters) {
      this.model.pendingSubmit.delete(key);
      resolve(null);
    }
    this.submitWaiters.clear();
    // The terminal is free now; a waiting PTY run may take it (the join aborts it when closing).
    this.attachWaiter?.();
    this.attachWaiter = null;
  }

  private maybeTick(): void {
    if (
      this.opts.animate === false ||
      !this.model.animating() ||
      this.screen.isClosed ||
      this.ticker !== null
    )
      return;
    const controller = new AbortController();
    this.ticker = controller;
    const tick = async (): Promise<void> => {
      try {
        for (;;) {
          try {
            await (this.opts.clock ?? systemClock).sleep(TICK_MS, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          }
          if (!this.model.animating() || this.screen.isClosed) return;
          this.model.beat += 1;
          if (this.screen.isActive) this.guard(() => this.render());
        }
      } finally {
        this.ticker = null;
      }
    };
    void tick().catch((error: unknown) =>
      this.guard(() => {
        throw error;
      }),
    );
  }

  private quit(reason: "key" | "signal"): void {
    this.close();
    this.opts.onQuit?.(reason);
  }

  private onKey(key: Key): void {
    const model = this.model;
    if (key.name === "quit") {
      this.quit("key");
      return;
    }
    if (key.name === "up" || key.name === "down") {
      model.move(key.name === "up" ? -1 : 1);
      this.render();
      return;
    }
    const entry = model.current();
    if (key.name === "enter" || (key.name === "char" && key.char === "a")) {
      this.attach(entry);
      return;
    }
    if (key.name !== "char" || entry === null || !model.pendingSubmit.has(entry.key)) return;
    const choices: Record<string, SubmitChoice> = {
      p: model.prLabel(),
      u: "push",
      n: "none",
      s: null,
    };
    if (!(key.char in choices)) return;
    const resolve = this.submitWaiters.get(entry.key);
    this.submitWaiters.delete(entry.key);
    model.pendingSubmit.delete(entry.key);
    model.message = null;
    this.render();
    resolve?.(choices[key.char] ?? null);
  }

  private attach(entry: TuiEntry | null): void {
    const kind = this.model.attachKind(entry);
    if (entry === null || kind === null) return;
    if (kind === "pty") {
      const resolve = this.attachWaiter;
      this.attachWaiter = null;
      this.model.pendingAttach = null;
      this.model.message = null;
      this.screen.suspend();
      resolve?.();
      return;
    }
    const argv = entry.agent?.focusCommand ?? [];
    const command = argv.join(" ");
    this.model.message = {
      text: `focusing the agent; from another terminal: ${command}`,
      tone: "info",
    };
    this.render();
    const run = this.opts.runFocus;
    if (run === undefined) return;
    run(argv).then(
      () => undefined,
      (error: unknown) => {
        this.model.message = {
          text: `focus failed (${errorMessage(error)}); run it yourself: ${command}`,
          tone: "error",
        };
        this.render();
      },
    );
  }
}

/**
 * `JoinView` over a {@link Tui}. Items are kept by `itemId`/`epoch`, so concurrent items form the
 * agent list; this device is the peer every item belongs to.
 */
export class TuiJoinView implements JoinView {
  readonly tui: Tui;
  private readonly entries = new Map<string, TuiEntry>();
  private peers: TuiPeer[] = [];
  private lastKey: string | null = null;
  private readonly session: string;

  constructor(opts: TuiOptions) {
    this.tui = new Tui(opts);
    this.session = opts.session ?? "joined";
    this.tui.start();
  }

  update(model: JoinViewModel): void {
    this.tui.guard(() => {
      this.absorb(model);
      if (!this.tui.screen.isClosed) this.tui.render();
    });
  }

  async chooseSubmit(model: JoinViewModel): Promise<SubmitChoice> {
    const key = this.absorb(model);
    if (key === null) return null;
    // The p label (pr or mr) must be right before the question is shown.
    await this.tui.hostReady;
    return this.tui.askSubmit(key);
  }

  suspend(): Promise<void> {
    // `runPty` reports "running" just before it asks for the terminal.
    const key = this.lastKey;
    if (key === null) {
      this.tui.screen.suspend();
      return Promise.resolve();
    }
    return this.tui.waitForAttach(key);
  }

  resume(): void {
    this.tui.guard(() => this.tui.resume());
  }

  close(): void {
    this.tui.close();
  }

  private absorb(model: JoinViewModel): string | null {
    this.peers = model.peers;
    const self = model.peers[0];
    let key: string | null = null;
    if (model.item !== null) {
      key = `${model.item.itemId}-e${model.item.epoch}`;
      this.entries.set(key, {
        key,
        peerId: self?.peerId ?? "this device",
        item: model.item,
        agent: model.agent,
        tail: model.tail,
        submit: model.submit,
      });
      this.lastKey = key;
    }
    this.tui.model.set({
      header: {
        session: this.session,
        device: self?.device ?? "-",
        role: self?.role ?? "-",
      },
      peers: this.peers,
      entries: [...this.entries.values()],
    });
    return key;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
