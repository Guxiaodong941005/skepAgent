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
  failedRun,
  failedText,
  fitSpans,
  type Glyphs,
  type Line,
  MIN_ROWS,
  progressBar,
  truncate,
} from "../tui.js";
import { SKEP_VERSION } from "../version.js";
import { logoLine, welcomeLines } from "./logo.js";
import {
  fitLine,
  joinCells,
  MAIN_PANEL,
  type PanelRect,
  progressNote,
  type ShellLayout,
  splitLayout,
} from "./panels.js";
import {
  anchorAt,
  FOLLOW,
  locateRow,
  type ScrollAnchor,
  scrollAnchor,
  viewWindow,
} from "./scroll.js";
import { QUIET_AFTER_MS } from "./session-controller.js";
import type { SlashCommand } from "./slash.js";
import {
  type EntryTag,
  Transcript,
  type TranscriptEntry,
  TranscriptRows,
  type TranscriptTone,
} from "./transcript.js";

export { wrapLine } from "./transcript.js";

export const MAX_BEE_ROWS = 3;
export const MAX_MENU_ROWS = 6;
/** Lines of a folded block (an item result) the main view shows before `/expand` (ORCH-7). */
export const FOLD_LINES = 8;
/** Below this the shell cannot show the input and footer, so only a notice is drawn. */
export const SHELL_MIN_ROWS = Math.min(10, MIN_ROWS);

export type ShellTone = TranscriptTone;
/** A footer row; `silentMs` is the time since the peer was last heard from, when known. */
/** `repo` is known only for a master's own roster (from its status), never for a joined shell. */
export type ShellPeer = JoinViewModel["peers"][number] & {
  silentMs?: number;
  repo?: string;
  protocolVersion?: number;
  skillRole?: string;
};

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
  skill?: string;
}

/** A peer panel's view: its own layout of the transcript, anchor and size in the last frame. */
interface PeerPanel {
  rows: TranscriptRows;
  anchor: ScrollAnchor;
  width: number;
  height: number;
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
  /** Live orchestration phases, e.g. `O-1 master agent refining 12s`; null when none run. */
  orchestration: string | null = null;
  version: string | null = SKEP_VERSION;
  /** `split` shows a panel per peer next to the main one (ORCH-5, D34). */
  layout: ShellLayout = "single";
  /** The panel the scroll keys move: {@link MAIN_PANEL} or a peer id. */
  focus: string = MAIN_PANEL;
  /** The focused panel takes the whole body. */
  zoomed = false;
  /**
   * Width and body height of the main view in the last frame. A wrapped entry spans several
   * rows, so scrolling is counted in rows at the current width, not in entries (SESSION-UX R7).
   */
  private width = 80;
  private bodyHeight = 0;
  private readonly mainRows: TranscriptRows;
  private readonly panels = new Map<string, PeerPanel>();
  /** Folded blocks the human expanded with `/expand` (ORCH-7). */
  private readonly expanded = new Set<string>();
  /** Keys of blocks that were folded, oldest first. */
  private readonly foldable: string[] = [];

  constructor(transcript: Transcript = new Transcript()) {
    this.transcript = transcript;
    // A peer's progress timeline belongs to its panel only; folded rest lines wait for /expand.
    this.mainRows = new TranscriptRows(transcript, (entry) => this.inMain(entry));
  }

  private inMain(entry: TranscriptEntry): boolean {
    if (entry.panelOnly === true) return false;
    if (entry.fold === undefined || entry.foldPart === undefined) return true;
    const open = this.expanded.has(entry.fold);
    return entry.foldPart === "rest" ? open : !open;
  }

  /** The main view's retained entries, oldest first, unfolded (no marker, no fold hints). */
  get scrollback(): readonly { text: string; tone: ShellTone }[] {
    return this.transcript
      .entries()
      .filter((entry) => entry.panelOnly !== true && entry.foldPart !== "hint")
      .map((entry) => ({ text: `${entry.gutter ?? ""}${entry.text}`, tone: entry.tone }));
  }

  /**
   * Appends one or more lines; a multi-line text becomes several entries. A pinned reader keeps
   * the same rows: the anchor names an entry, so output below never moves the view (§5.1).
   *
   * With `tag.fold` a block longer than {@link FOLD_LINES} shows only its head in the main view,
   * then one hint line; `/expand <key>` shows the rest. Peer panels always show it whole.
   */
  append(text: string, tone: ShellTone = "info", gutter?: string, tag?: EntryTag): void {
    const lines = text.replace(/\n+$/, "").split("\n");
    const key = tag?.fold;
    if (key === undefined || lines.length <= FOLD_LINES + 1) {
      // A short block stays whole; its key without a fold part changes nothing.
      for (const line of lines) this.transcript.append(line, tone, gutter, tag);
      return;
    }
    if (!this.foldable.includes(key)) this.foldable.push(key);
    const where = tag?.peer === undefined ? "" : ` or the ${tag.peer} panel`;
    lines.forEach((line, index) => {
      if (index === FOLD_LINES) {
        const more = lines.length - FOLD_LINES;
        this.transcript.append(`… ${more} more lines · /expand ${key}${where}`, "muted", gutter, {
          fold: key,
          foldPart: "hint",
        });
      }
      const part = index < FOLD_LINES ? {} : { foldPart: "rest" as const };
      this.transcript.append(line, tone, gutter, { ...tag, ...part });
    });
  }

  /** `key` names a block the main view folds (expanded or not). */
  hasFold(key: string): boolean {
    return this.foldable.includes(key);
  }

  /**
   * Shows (or folds again) a block in the main view. `key` null means the newest folded block;
   * `all` every one. Returns the keys it changed, empty when `key` names no folded block.
   */
  setExpanded(key: string | null, open: boolean): string[] {
    const changes = (entry: string) => this.expanded.has(entry) !== open;
    const keys =
      key === "all"
        ? this.foldable.filter(changes)
        : [key ?? this.foldable.findLast(changes)].filter(
            (entry): entry is string =>
              entry !== undefined && this.foldable.includes(entry) && changes(entry),
          );
    for (const entry of keys) {
      if (open) this.expanded.add(entry);
      else this.expanded.delete(entry);
    }
    if (keys.length > 0) this.mainRows.refilter();
    return keys;
  }

  /**
   * The panel the keys act on: the focused one while split, if it still exists (a peer that left
   * takes its panel with it), else the main view.
   */
  get activePanel(): string {
    if (this.layout !== "split" || this.focus === MAIN_PANEL) return MAIN_PANEL;
    return this.peers.some((peer) => peer.peerId === this.focus) ? this.focus : MAIN_PANEL;
  }

  /** Rendered rows between the bottom of the active panel's body and its newest row. */
  get scroll(): number {
    const id = this.activePanel;
    return viewWindow(this.anchorOf(id), this.rows(id), this.heightOf(id)).below;
  }

  /** Moves the active panel by `rows` rendered rows (positive is up), within its entries. */
  scrollBy(rows: number): void {
    const id = this.activePanel;
    this.setAnchor(id, scrollAnchor(this.anchorOf(id), rows, this.rows(id), this.heightOf(id)));
  }

  scrollToTop(): void {
    const id = this.activePanel;
    this.setAnchor(id, anchorAt(0, this.rows(id), this.heightOf(id)));
  }

  scrollToBottom(): void {
    this.setAnchor(this.activePanel, FOLLOW);
  }

  /** The main view follows new output again, whichever panel has the focus. */
  followMain(): void {
    this.anchor = FOLLOW;
  }

  /** One page: the body less one row, so the reader keeps a line of context. */
  pageRows(): number {
    return Math.max(1, this.heightOf(this.activePanel) - 1);
  }

  /** The largest scroll: the first rendered row at the top of the body. */
  maxScroll(): number {
    const id = this.activePanel;
    return Math.max(0, this.rows(id).totalRows - this.heightOf(id));
  }

  /**
   * Pins the active panel to the newest entry before the top of its view whose text contains
   * `query` (case-insensitive), passing over entries `skip` rejects (the echoed `/find` itself).
   * False when there is none; the view then stays.
   */
  findBack(query: string, skip: (text: string) => boolean = () => false): boolean {
    const id = this.activePanel;
    const space = this.rows(id);
    const needle = query.toLowerCase();
    if (needle === "" || space.entryCount === 0) return false;
    const height = this.heightOf(id);
    const { top } = viewWindow(this.anchorOf(id), space, height);
    // Following: the whole visible page counts as already seen only once something is pinned.
    let index =
      this.anchorOf(id).kind === "bottom" ? space.entryCount - 1 : locateRow(space, top) - 1;
    for (; index >= 0; index--) {
      const entry = space.entry(index) as TranscriptEntry;
      const text = `${entry.gutter ?? ""}${entry.text}`;
      if (!skip(text) && text.toLowerCase().includes(needle)) {
        this.setAnchor(id, { kind: "pinned", seq: entry.seq, row: 0 });
        return true;
      }
    }
    return false;
  }

  private anchorOf(id: string): ScrollAnchor {
    return id === MAIN_PANEL ? this.anchor : this.panel(id).anchor;
  }

  private setAnchor(id: string, anchor: ScrollAnchor): void {
    if (id === MAIN_PANEL) this.anchor = anchor;
    else this.panel(id).anchor = anchor;
  }

  private heightOf(id: string): number {
    return id === MAIN_PANEL ? this.bodyHeight : this.panel(id).height;
  }

  private rows(id: string = MAIN_PANEL): TranscriptRows {
    if (id === MAIN_PANEL) return this.mainRows.sync(this.width);
    const panel = this.panel(id);
    return panel.rows.sync(panel.width);
  }

  private panel(id: string): PeerPanel {
    let panel = this.panels.get(id);
    if (panel === undefined) {
      panel = {
        rows: new TranscriptRows(
          this.transcript,
          (entry) => entry.peer === id && entry.foldPart !== "hint",
        ),
        anchor: FOLLOW,
        width: this.width,
        height: 0,
      };
      this.panels.set(id, panel);
    }
    return panel;
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
      ...(this.header.skill && this.header.skill !== "generic"
        ? [`skill: ${this.header.skill}`]
        : []),
      `cwd  ${this.header.cwd}`,
      ...(this.sessionLive ? [`peers ${this.peers.length}`] : ["no session"]),
      ...(this.sessionLive && this.link !== null ? [this.link] : []),
    ];
    const lines: Line[] = [
      logoLine(columns, this.glyphs, context, this.version),
      { spans: [fg("on-surface-variant", `  ${info.join(g.sep)}`)] },
    ];
    const bee = [
      ...(this.orchestration === null
        ? []
        : [{ spans: [fg("tertiary", `  ${this.orchestration}`)] }]),
      ...this.beeRows(columns),
    ];
    const hint = this.hintLine();
    const prompt = this.question === null ? "> " : `${this.question} `;
    const input = this.inputLine(columns, prompt);
    const bodyRows = Math.max(0, rows - lines.length - 1 - 1 - bee.length - 1);
    this.width = columns;
    this.bodyHeight = bodyRows;
    const split = this.layout === "split" && this.sessionLive;
    const body = split ? this.splitBody(columns, bodyRows) : this.bodyLines(bodyRows);
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

  private bodyLines(count: number, id: string = MAIN_PANEL): Line[] {
    let visible: Line[];
    const space = this.rows(id);
    if (id === MAIN_PANEL && space.entryCount === 0) {
      visible = welcomeLines(this.glyphs).slice(-count);
    } else if (space.entryCount === 0) {
      visible = [{ spans: [fg("on-surface-variant", `  (nothing from ${id} yet)`)] }].slice(
        0,
        count,
      );
      return [...visible, ...Array<Line>(Math.max(0, count - visible.length)).fill("")];
    } else {
      const { top } = viewWindow(this.anchorOf(id), space, count);
      visible = space.window(top, count).map(({ entry, text }) => ({
        spans: [fg(TONE_ROLES[entry.tone], text)],
      }));
    }
    return [...Array<Line>(Math.max(0, count - visible.length)).fill(""), ...visible];
  }

  /**
   * The body as panels (ORCH-5): each panel is a title row over its own view of the transcript,
   * and body rows are the panels' rows joined left to right.
   */
  private splitBody(columns: number, rows: number): Line[] {
    const peers = this.peers.map((peer) => peer.peerId);
    const focus = this.activePanel;
    const layout = splitLayout(columns, rows, peers, focus, this.zoomed);
    const cells = layout.panels.map((rect) => {
      const height = Math.max(0, rect.height - 1);
      if (rect.id === MAIN_PANEL) {
        this.width = rect.width;
        this.bodyHeight = height;
      } else {
        const panel = this.panel(rect.id);
        panel.width = rect.width;
        panel.height = height;
      }
      const title = this.panelTitle(rect, focus, rect.id === MAIN_PANEL ? layout.hidden : []);
      const lines = rect.height === 0 ? [] : [title, ...this.bodyLines(height, rect.id)];
      return { rect, lines: lines.map((line) => fitLine(line, rect.width)) };
    });
    const separator = fg("outline", this.glyphs === "nerd" ? "│" : "|");
    const out: Line[] = [];
    for (let row = 0; row < rows; row++) {
      const here = cells
        .filter(({ rect }) => row >= rect.top && row < rect.top + rect.height)
        .sort((left, right) => left.rect.left - right.rect.left)
        .map(({ rect, lines }) => ({ spans: lines[row - rect.top] ?? [] }));
      out.push(joinCells(here, separator));
    }
    return out;
  }

  /** `── > peer-2 · mac · api · coding · working 40% ───`: the focused title is bold. */
  private panelTitle(rect: PanelRect, focus: string, hidden: readonly string[]): Line {
    const g = chrome(this.glyphs);
    const focused = rect.id === focus;
    const mark = focused ? (this.glyphs === "nerd" ? "▸ " : "> ") : "";
    // Next to the name, so a long progress line cannot push it out of a narrow panel.
    const scrolled = this.anchorOf(rect.id).kind === "pinned" ? [`scrolled`] : [];
    let parts: string[];
    if (rect.id === MAIN_PANEL) {
      const more = hidden.length === 0 ? [] : [`+${hidden.length} more (tab)`];
      parts = [MAIN_PANEL, ...scrolled, ...more];
    } else {
      const peer = this.peers.find((entry) => entry.peerId === rect.id);
      parts =
        peer === undefined
          ? [rect.id, ...scrolled]
          : [
              ...(peer.skillRole ? [peer.skillRole] : []),
              peer.peerId,
              ...scrolled,
              peer.device,
              ...(peer.repo === undefined ? [] : [peer.repo]),
              peer.role,
              progressNote(peer.state, peer.progress),
            ];
    }
    const text = ` ${mark}${parts.join(g.sep)} `;
    const fill = Math.max(0, rect.width - 2 - displayWidth(text));
    return {
      spans: [
        fg("outline", g.rule.repeat(2)),
        focused ? bold(text, "primary") : fg("on-surface-variant", text),
        fg("outline", g.rule.repeat(fill)),
      ],
    };
  }

  /**
   * The rule under the input; while the view is pinned it says how much is above and below and
   * how to follow again (S6).
   */
  private ruleLine(columns: number): Line {
    const g = chrome(this.glyphs);
    const id = this.activePanel;
    if (this.anchorOf(id).kind === "bottom" || this.rows(id).entryCount === 0) {
      return { spans: [fg("outline", `  ${g.rule.repeat(Math.max(0, columns - 2))}`)] };
    }
    const { above, below } = viewWindow(this.anchorOf(id), this.rows(id), this.heightOf(id));
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
    // Only a master knows its peers' repos; a joined shell's rows keep the old columns.
    const repos = shown.some((peer) => peer.repo !== undefined);
    const repoWidth = Math.min(
      16,
      Math.max(6, ...shown.map((peer) => displayWidth(peer.repo ?? "-"))),
    );
    const lines: Line[] = shown.map((peer) => {
      const progress = peer.progress;
      const phase = progress?.phase ?? "idle";
      const spans: Span[] = [
        { text: `  ${column(peer.device, deviceWidth)}  ` },
        ...(repos ? [{ text: `${column(peer.repo ?? "-", repoWidth)}  ` }] : []),
        fg("on-surface-variant", `${column(peer.role, roleWidth)}  `),
        fg("primary", `${beeLane(phase, this.beat, this.glyphs)} `),
      ];
      if (progress === undefined) {
        spans.push(chip(peer.state), { text: "  " }, ...this.presence(peer));
      } else {
        const failed = failedRun(progress);
        if (columns >= 60) {
          spans.push(
            fg("outline", "["),
            fg(failed ? "error" : "primary", progressBar(progress.percent, this.glyphs)),
            fg("outline", "] "),
          );
        }
        if (failed) {
          spans.push(fg("error", failedText(progress)), { text: "  " });
        } else {
          spans.push(bold(`${progress.percent}%`));
          if (columns >= 70) {
            spans.push(fg("on-surface-variant", ` ${progress.done}/${progress.total}`));
          }
          spans.push({ text: " " }, chip(phase), { text: "  " });
        }
        spans.push(...this.presence(peer));
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
            : this.layout === "split" && this.sessionLive
              ? ["/ commands", "enter send", "tab panel", "pgup/pgdn scroll", "/layout single"]
              : ["/ commands", "enter send", "pgup/pgdn/wheel scroll", "ctrl+c clear", "/quit"];
    return { spans: [fg("on-surface-variant", `  ${keys.join(separator)}`)] };
  }
}
