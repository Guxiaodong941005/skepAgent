/**
 * Frame layout of the unified shell: header, scrollback, slash menu, input, bee footer, hint
 * (docs/plans/unified-tui-shell.md §2–§3). Visual chrome from feat/unified-tui-shell-ui;
 * controller API kept for run.ts.
 */

import type { JoinViewModel } from "../commands/session.js";
import { bold, fg, type Role, type Span } from "../theme.js";
import {
  beeLane,
  chip,
  chrome,
  column,
  displayWidth,
  fitSpans,
  type Glyphs,
  type Line,
  MIN_ROWS,
  progressBar,
  truncate,
} from "../tui.js";
import { SKEP_VERSION } from "../version.js";
import { logoLine, welcomeLines } from "./logo.js";
import { anchorAt, FOLLOW, type ScrollAnchor, scrollAnchor, viewWindow } from "./scroll.js";
import { QUIET_AFTER_MS } from "./session-controller.js";
import type { SlashCommand } from "./slash.js";
import { Transcript, TranscriptRows, type TranscriptTone } from "./transcript.js";

export { wrapLine } from "./transcript.js";

export const MAX_BEE_ROWS = 3;
export const MAX_MENU_ROWS = 6;
/** Below this the shell cannot show the input and footer, so only a notice is drawn. */
export const SHELL_MIN_ROWS = Math.min(10, MIN_ROWS);

export type ShellTone = TranscriptTone;
/** A footer row; `silentMs` is the time since the peer was last heard from, when known. */
/** `repo` is known only for a master's own roster (from its status), never for a joined shell. */
export type ShellPeer = JoinViewModel["peers"][number] & { silentMs?: number; repo?: string };

/** The multi-peer picker shown after an intent when several peers could take it (INTENT-PEER). */
export interface ShellPicker {
  title: string;
  rows: { label: string; selected: boolean }[];
  cursor: number;
}

export interface ShellHeader {
  device: string;
  cwd: string;
  /** e.g. `no session`, `master · code 4821-0937-5520`, `joined · peer-2`. */
  session: string;
}

const TONE_ROLES: Record<ShellTone, Role> = {
  info: "on-surface",
  event: "secondary",
  warn: "tertiary",
  error: "error",
  muted: "on-surface-variant",
};

export class ShellModel {
  header: ShellHeader = { device: "-", cwd: "-", session: "no session" };
  /** Everything this shell session showed (locked §9.3: same session, max 500K characters). */
  readonly transcript: Transcript;
  /** Follows new output, or is pinned to an entry while the human reads older rows (§5.1). */
  anchor: ScrollAnchor = FOLLOW;
  input = "";
  menu: SlashCommand[] = [];
  menuIndex = 0;
  peers: ShellPeer[] = [];
  sessionLive = false;
  /** A joined shell's link to its master, e.g. `master heard 3s ago`. */
  link: string | null = null;
  glyphs: Glyphs = "nerd";
  beat = 0;
  /** A pending question takes the input; the prompt shows it. */
  question: string | null = null;
  /** While set, the picker takes the keys and replaces the command menu above the input. */
  picker: ShellPicker | null = null;
  version: string | null = SKEP_VERSION;
  /**
   * Width and body height of the last frame. A wrapped entry spans several rows, so scrolling is
   * counted in rows at the current width, not in entries (SESSION-UX R7).
   */
  private width = 80;
  private bodyHeight = 0;
  private readonly layout: TranscriptRows;

  constructor(transcript: Transcript = new Transcript()) {
    this.transcript = transcript;
    this.layout = new TranscriptRows(transcript);
  }

  /** The retained entries, oldest first (the drop marker is not one). */
  get scrollback(): readonly { text: string; tone: ShellTone }[] {
    return this.transcript
      .entries()
      .map((entry) => ({ text: `${entry.gutter ?? ""}${entry.text}`, tone: entry.tone }));
  }

  /**
   * Appends one or more lines; a multi-line text becomes several entries. A pinned reader keeps
   * the same rows: the anchor names an entry, so output below never moves the view (§5.1).
   */
  append(text: string, tone: ShellTone = "info", gutter?: string): void {
    for (const line of text.replace(/\n+$/, "").split("\n")) {
      this.transcript.append(line, tone, gutter);
    }
  }

  /** Rendered rows between the bottom of the body and the newest row. */
  get scroll(): number {
    return viewWindow(this.anchor, this.rows(), this.bodyHeight).below;
  }

  /** Moves the view by `rows` rendered rows (positive is up), within the transcript. */
  scrollBy(rows: number): void {
    this.anchor = scrollAnchor(this.anchor, rows, this.rows(), this.bodyHeight);
  }

  scrollToTop(): void {
    this.anchor = anchorAt(0, this.rows(), this.bodyHeight);
  }

  scrollToBottom(): void {
    this.anchor = FOLLOW;
  }

  /** One page: the body less one row, so the reader keeps a line of context. */
  pageRows(): number {
    return Math.max(1, this.bodyHeight - 1);
  }

  /** The largest scroll: the first rendered row at the top of the body. */
  maxScroll(): number {
    return Math.max(0, this.rows().totalRows - this.bodyHeight);
  }

  private rows(): TranscriptRows {
    return this.layout.sync(this.width);
  }

  animating(): boolean {
    return this.peers.some((peer) => {
      const phase = peer.progress?.phase ?? peer.state;
      return phase === "working" || phase === "blocked";
    });
  }

  frame(columns: number, rows: number): Line[] {
    if (rows < SHELL_MIN_ROWS) {
      return [
        {
          spans: [
            fg(
              "error",
              `terminal too small: ${columns}x${rows}; resize to at least ${SHELL_MIN_ROWS} rows`,
            ),
          ],
        },
      ];
    }
    const g = chrome(this.glyphs);
    const sessionLabel =
      this.header.session === "no session" ? "" : this.header.session.replace(/^session\s+/i, "");
    const context =
      sessionLabel === ""
        ? ""
        : sessionLabel.startsWith("session")
          ? sessionLabel
          : `session ${sessionLabel}`;
    const info = [
      `device  ${this.header.device}`,
      `cwd  ${this.header.cwd}`,
      ...(this.sessionLive ? [`peers ${this.peers.length}`] : ["no session"]),
      ...(this.sessionLive && this.link !== null ? [this.link] : []),
    ];
    const lines: Line[] = [
      logoLine(columns, this.glyphs, context, this.version),
      { spans: [fg("on-surface-variant", `  ${info.join(g.sep)}`)] },
    ];
    const bee = this.beeRows(columns);
    const hint = this.hintLine();
    const prompt = this.question === null ? "> " : `${this.question} `;
    const input = this.inputLine(columns, prompt);
    const bodyRows = Math.max(0, rows - lines.length - 1 - 1 - bee.length - 1);
    this.width = columns;
    this.bodyHeight = bodyRows;
    const body = this.bodyLines(bodyRows);
    const rule = this.ruleLine(columns);
    const overlay =
      this.picker === null ? this.menuLines() : this.pickerLines(this.picker, bodyRows);
    const menu = bodyRows === 0 ? [] : overlay.slice(-bodyRows);
    body.splice(body.length - menu.length, menu.length, ...menu);
    const out = [...lines, ...body, input, rule, ...bee, hint];
    return out.map((line) =>
      typeof line === "string"
        ? truncate(line, columns)
        : { ...line, spans: fitSpans(line.spans, columns) },
    );
  }

  private bodyLines(count: number): Line[] {
    let visible: Line[];
    if (this.transcript.length === 0) {
      visible = welcomeLines(this.glyphs).slice(-count);
    } else {
      const space = this.rows();
      const { top } = viewWindow(this.anchor, space, count);
      visible = space.window(top, count).map(({ entry, text }) => ({
        spans: [fg(TONE_ROLES[entry.tone], text)],
      }));
    }
    return [...Array<Line>(Math.max(0, count - visible.length)).fill(""), ...visible];
  }

  /**
   * The rule under the input; while the view is pinned it says how much is above and below and
   * how to follow again (S6).
   */
  private ruleLine(columns: number): Line {
    const g = chrome(this.glyphs);
    if (this.anchor.kind === "bottom" || this.transcript.length === 0) {
      return { spans: [fg("outline", `  ${g.rule.repeat(Math.max(0, columns - 2))}`)] };
    }
    const { above, below } = viewWindow(this.anchor, this.rows(), this.bodyHeight);
    const [up, down] = this.glyphs === "nerd" ? ["↑", "↓"] : ["^", "v"];
    const label = ` ${up} ${above} lines above${g.sep}${down} ${below} lines below — End to follow `;
    const fill = Math.max(0, columns - 4 - displayWidth(label));
    return {
      spans: [
        fg("outline", `  ${g.rule.repeat(2)}`),
        fg("tertiary", label),
        fg("outline", g.rule.repeat(fill)),
      ],
    };
  }

  private menuLines(): Line[] {
    const shown = this.menu.slice(0, MAX_MENU_ROWS);
    return shown.map((command, index) => {
      const usage = command.usage === undefined ? "" : ` ${command.usage}`;
      return {
        spans: [
          { text: "  " },
          bold(`/${command.name}`, "primary"),
          fg("secondary", usage),
          fg("on-surface-variant", `  ${command.description}`),
        ],
        selected: index === this.menuIndex,
        fill: true,
      };
    });
  }

  private pickerLines(picker: ShellPicker, maxRows: number): Line[] {
    if (maxRows === 0) return [];
    const title = maxRows > 1 ? [{ spans: [bold(`  ${picker.title}`, "primary")] }] : [];
    const count = maxRows - title.length;
    // Keep the active peer visible even in a short terminal or a roster larger than the body.
    const first = Math.min(
      Math.max(0, picker.cursor - count + 1),
      Math.max(0, picker.rows.length - count),
    );
    const mark = (selected: boolean) => (selected ? "[x]" : "[ ]");
    return [
      ...title,
      ...picker.rows.slice(first, first + count).map((row, index) => ({
        spans: [{ text: `  ${mark(row.selected)} ${row.label}` }],
        selected: first + index === picker.cursor,
        fill: true,
      })),
    ];
  }

  private inputLine(columns: number, prompt: string): Line {
    const characters = [...this.input];
    const available = Math.max(0, columns - displayWidth(prompt) - 1);
    const shown = truncate(characters.join(""), available);
    return {
      spans: [
        bold(prompt, "primary"),
        { text: shown },
        { text: "_", role: "primary", inverse: true },
      ],
    };
  }

  private beeRows(columns: number): Line[] {
    if (!this.sessionLive) {
      return [{ spans: [fg("on-surface-variant", "  (no session — /start or /join)")] }];
    }
    if (this.peers.length === 0) return [{ spans: [fg("on-surface-variant", "  (no peers yet)")] }];
    const overflow = this.peers.length > MAX_BEE_ROWS;
    const shown = this.peers.slice(0, overflow ? MAX_BEE_ROWS - 1 : MAX_BEE_ROWS);
    const deviceWidth = Math.min(
      12,
      Math.max(6, ...shown.map((peer) => displayWidth(peer.device))),
    );
    const roleWidth = Math.min(10, Math.max(6, ...shown.map((peer) => displayWidth(peer.role))));
    const lines: Line[] = shown.map((peer) => {
      const progress = peer.progress;
      const phase = progress?.phase ?? "idle";
      const spans: Span[] = [
        { text: `  ${column(peer.device, deviceWidth)}  ` },
        fg("on-surface-variant", `${column(peer.role, roleWidth)}  `),
        fg("primary", `${beeLane(phase, this.beat, this.glyphs)} `),
      ];
      if (progress === undefined) {
        spans.push(chip(peer.state), { text: "  " }, ...this.presence(peer));
      } else {
        const failed = progress.phase === "done" && progress.failed > 0;
        if (columns >= 60) {
          spans.push(
            fg("outline", "["),
            fg(failed ? "error" : "primary", progressBar(progress.percent, this.glyphs)),
            fg("outline", "] "),
          );
        }
        spans.push(bold(`${progress.percent}%`));
        if (columns >= 70) {
          spans.push(fg("on-surface-variant", ` ${progress.done}/${progress.total}`));
        }
        spans.push({ text: " " }, chip(phase), { text: "  " });
        spans.push(...this.presence(peer));
        if (failed) spans.push(fg("error", `(${progress.failed} failed)  `));
        spans.push({ text: progress.summary });
      }
      return { spans };
    });
    if (overflow) {
      lines.push({
        spans: [fg("on-surface-variant", `  +${this.peers.length - shown.length} more`)],
      });
    }
    return lines;
  }

  /** Heartbeat display: when the peer was last heard from; quiet links are flagged. */
  private presence(peer: ShellPeer): Span[] {
    if (peer.silentMs === undefined) return [];
    const seconds = Math.floor(peer.silentMs / 1000);
    if (peer.silentMs >= QUIET_AFTER_MS) return [fg("error", `quiet ${seconds}s  `)];
    return [fg("on-surface-variant", `${this.glyphs === "nerd" ? "♥" : "hb"} ${seconds}s  `)];
  }

  private hintLine(): Line {
    const separator = chrome(this.glyphs).sep;
    const keys =
      this.picker !== null
        ? [
            this.glyphs === "nerd" ? "↑↓ move" : "up/down move",
            "space toggle",
            "enter send",
            "esc cancel",
          ]
        : this.question !== null
          ? ["enter answer", "ctrl+c clear"]
          : this.menu.length > 0
            ? [
                this.glyphs === "nerd" ? "↑↓ select" : "up/down select",
                "tab/enter accept",
                "esc close",
              ]
            : ["/ commands", "enter send", "pgup/pgdn/wheel scroll", "ctrl+c clear", "/quit"];
    return { spans: [fg("on-surface-variant", `  ${keys.join(separator)}`)] };
  }
}
