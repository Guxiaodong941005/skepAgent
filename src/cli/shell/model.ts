import { bold, fg, type Span } from "../theme.js";
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
  type TuiPeer,
  truncate,
} from "../tui.js";
import { SKEP_VERSION } from "../version.js";
import { applyInputKey, createInputState, type InputKey, type InputState } from "./input.js";
import { logoLine, welcomeLines } from "./logo.js";
import { MAX_SLASH_ROWS, type ShellCtx, type SlashCommand, slashMenu } from "./slash.js";

export { MIN_ROWS } from "../tui.js";
export const SCROLLBACK_LIMIT = 1_000;
export const MAX_BEE_PEERS = 3;

export interface ShellOptions<Ctx extends ShellCtx = ShellCtx> {
  context: Ctx;
  commands: readonly SlashCommand<Ctx>[];
  glyphs?: Glyphs;
  scrollbackLimit?: number;
}

export type ShellAction = { type: "submit"; text: string } | { type: "attach"; itemId: string };

export class ShellModel<Ctx extends ShellCtx = ShellCtx> {
  readonly context: Ctx;
  readonly commands: readonly SlashCommand<Ctx>[];
  readonly scrollbackLimit: number;
  private readonly output: Line[] = [];
  input: InputState = createInputState();
  peers: TuiPeer[] = [];
  scrollOffset = 0;
  beat = 0;
  glyphs: Glyphs;
  version: string | null = SKEP_VERSION;
  pendingAttach: string | null = null;

  constructor(options: ShellOptions<Ctx>) {
    this.context = options.context;
    this.commands = options.commands;
    this.glyphs = options.glyphs ?? "nerd";
    this.scrollbackLimit = Math.max(1, Math.floor(options.scrollbackLimit ?? SCROLLBACK_LIMIT));
  }

  get draft(): string {
    return this.input.draft;
  }

  set draft(draft: string) {
    this.input = createInputState(draft);
  }

  get scrollback(): readonly Line[] {
    return this.output;
  }

  append(line: Line, role: Span["role"] = "on-surface"): void {
    const lines: Line[] =
      typeof line === "string"
        ? line.split(/\r?\n/).map((text) => ({ spans: [fg(role ?? "on-surface", text)] }))
        : [{ ...line, spans: line.spans.map((span) => ({ ...span })) }];
    this.output.push(...lines);
    const excess = this.output.length - this.scrollbackLimit;
    if (excess > 0) this.output.splice(0, excess);
    if (this.scrollOffset > 0) {
      this.scrollOffset = Math.min(this.output.length, this.scrollOffset + lines.length);
    }
  }

  animating(): boolean {
    return (
      this.context.session !== null &&
      this.peers.some(
        (peer) => peer.progress?.phase === "working" || peer.progress?.phase === "blocked",
      )
    );
  }

  scroll(delta: number, rows = MIN_ROWS): void {
    const maximum = Math.max(0, this.output.length - this.contentRows(rows));
    this.scrollOffset = Math.max(0, Math.min(maximum, this.scrollOffset + delta));
  }

  handleKey(key: InputKey, rows = MIN_ROWS): ShellAction | null {
    if (
      key.name === "char" &&
      key.char === "a" &&
      this.draft === "" &&
      this.pendingAttach !== null
    ) {
      return { type: "attach", itemId: this.pendingAttach };
    }
    const update = applyInputKey(this.input, key, this.commands, this.context);
    this.input = update.state;
    if (update.action?.type === "scroll") {
      this.scroll(update.action.direction * this.contentRows(rows), rows);
      return null;
    }
    if (update.action?.type === "submit") {
      this.scrollOffset = 0;
      return update.action;
    }
    return null;
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
    const glyphs = chrome(this.glyphs);
    const session = this.context.session;
    const sessionLabel =
      session === null
        ? ""
        : `session live${glyphs.sep}${session.role}${session.code === undefined ? "" : `${glyphs.sep}code ${session.code}`}`;
    const info = [
      `device  ${this.context.device}`,
      `cwd  ${this.context.cwd}`,
      ...(session === null
        ? ["no session"]
        : [`role ${this.context.role}`, `peers ${this.peers.length}`]),
    ];
    const lines: Line[] = [
      logoLine(columns, this.glyphs, sessionLabel, this.version),
      { spans: [fg("on-surface-variant", `  ${info.join(glyphs.sep)}`)] },
    ];
    const room = this.contentRows(rows);
    if (this.output.length === 0 && session === null) {
      lines.push(...welcomeLines(this.glyphs).slice(0, room));
      while (lines.length < room + 2) lines.push("");
    } else {
      const offset = Math.min(this.scrollOffset, Math.max(0, this.output.length - room));
      const end = this.output.length - offset;
      const visible = this.output.slice(Math.max(0, end - room), end);
      while (lines.length < room + 2 - visible.length) lines.push("");
      lines.push(...visible);
    }
    this.overlay(lines);
    lines.push(
      this.inputLine(columns),
      { spans: [fg("outline", `  ${glyphs.rule.repeat(Math.max(0, columns - 2))}`)] },
      ...this.beeFooter(columns),
      this.hint(),
    );
    return lines.map((line) =>
      typeof line === "string"
        ? truncate(line, columns)
        : { ...line, spans: fitSpans(line.spans, columns) },
    );
  }

  private footerRows(): number {
    if (this.context.session === null || this.peers.length === 0) return 1;
    return Math.min(this.peers.length, MAX_BEE_PEERS) + (this.peers.length > MAX_BEE_PEERS ? 1 : 0);
  }

  private contentRows(rows: number): number {
    return Math.max(0, rows - 2 - 1 - 1 - this.footerRows() - 1);
  }

  private overlay(lines: Line[]): void {
    if (!this.input.menuOpen) return;
    const menu = slashMenu(this.draft, this.commands, this.context);
    if (menu === null) return;
    const selected = Math.min(this.input.menuIndex, Math.max(0, menu.commands.length - 1));
    const start = Math.max(0, selected - MAX_SLASH_ROWS + 1);
    const shown = menu.commands.slice(start, start + MAX_SLASH_ROWS);
    const overlay: Line[] = shown.map((command, index) => ({
      spans: [
        { text: "  " },
        bold(`/${command.name}`, "primary"),
        fg("secondary", command.usage === undefined ? "" : ` ${command.usage}`),
        fg("on-surface-variant", `  ${command.description}`),
      ],
      selected: menu.mode === "commands" && start + index === selected,
      fill: true,
    }));
    if (overlay.length === 0) {
      overlay.push({ spans: [fg("on-surface-variant", "  No matching commands; try /help")] });
    }
    lines.splice(lines.length - overlay.length, overlay.length, ...overlay);
  }

  private inputLine(columns: number): Line {
    const characters = [...this.draft];
    const cursor = Math.max(0, Math.min(this.input.cursor, characters.length));
    const before = characters.slice(0, cursor);
    const available = Math.max(0, columns - 3);
    let beforeWidth = displayWidth(before.join(""));
    let start = 0;
    while (beforeWidth > available) {
      beforeWidth -= displayWidth(before[start] ?? "");
      start += 1;
    }
    return {
      spans: [
        bold("> ", "primary"),
        { text: before.slice(start).join("") },
        { text: "_", role: "primary", inverse: true },
        { text: truncate(characters.slice(cursor).join(""), available - beforeWidth) },
      ],
    };
  }

  private beeFooter(columns: number): Line[] {
    if (this.context.session === null || this.peers.length === 0) {
      return [{ spans: [fg("on-surface-variant", "  (no peers yet)")] }];
    }
    const peers = this.peers.slice(0, MAX_BEE_PEERS);
    const deviceWidth = Math.min(12, Math.max(...peers.map((peer) => displayWidth(peer.device))));
    const roleWidth = Math.min(10, Math.max(...peers.map((peer) => displayWidth(peer.role))));
    const lines: Line[] = peers.map((peer) => {
      const spans: Span[] = [
        { text: `  ${column(peer.device, deviceWidth)}  ` },
        fg("on-surface-variant", `${column(peer.role, roleWidth)}  `),
      ];
      const progress = peer.progress;
      if (progress === undefined) {
        spans.push(
          fg("on-surface-variant", beeLane("idle", this.beat, this.glyphs)),
          chip(peer.state),
        );
      } else {
        const failed = progress.phase === "done" && progress.failed > 0;
        spans.push(
          fg(
            chip(progress.phase).role ?? "on-surface",
            beeLane(progress.phase, this.beat, this.glyphs),
          ),
          { text: " " },
        );
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
        spans.push({ text: " " }, chip(progress.phase), { text: "  " });
        if (failed) spans.push(fg("error", `(${progress.failed} failed)  `));
        spans.push({ text: progress.summary });
      }
      return { spans };
    });
    if (this.peers.length > MAX_BEE_PEERS) {
      lines.push({
        spans: [fg("on-surface-variant", `  +${this.peers.length - MAX_BEE_PEERS} more`)],
      });
    }
    return lines;
  }

  private hint(): Line {
    const separator = chrome(this.glyphs).sep;
    const keys = this.input.menuOpen
      ? [this.glyphs === "nerd" ? "↑↓ select" : "up/down select", "tab/enter accept", "esc close"]
      : ["/ commands", "enter send", "ctrl+c clear"];
    if (this.pendingAttach !== null) keys.push("a attach");
    keys.push("/quit leave");
    if (this.scrollOffset > 0) keys.push("pgdn newest");
    return { spans: [fg("on-surface-variant", `  ${keys.join(separator)}`)] };
  }
}
