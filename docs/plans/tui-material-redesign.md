# Plan: Skep TUI design system (terminal Material) — 0.1.5

Status: **plan only — nothing is implemented yet.** Branch: `feat/tui-material-0.1.5`, cut from
`feat/peer-progress-bee` (it already has the Nerd Font bee). Do not bump the version in this
work; the release task does that.

Sources:

* [Material Design 3: how the color system works](https://m3.material.io/styles/color/system/how-the-system-works).
  We use its ideas: one source color, tonal palettes, *roles* rather than raw colors, and paired
  roles (`on-X` text on `X`) that keep contrast by construction.
* [Google Stitch DESIGN.md](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/).
  We use its ideas: semantic tokens written down in one place, an explicit hierarchy, and
  accessible contrast. §3 is our DESIGN.md.
* Peer progress plan: [`peer-progress-bee.md`](peer-progress-bee.md).
* Current code: `src/cli/tui.ts`, `src/cli/tui.test.ts`, `src/cli/commands/ui.ts`.

---

## 0. Facts from the current code this plan depends on

* `TuiModel.frame(columns, rows)` is pure and returns `Line[]`, where
  `Line = string | { text; style: "inverse" | "bold" }`. `Screen.draw` adds the escapes and
  truncates each line. **Tests assert plain text** (`term.frame()` removes every
  `ESC[…letter` sequence, and that also removes `38;5;n` and `38;2;r;g;b` SGR). So we can add
  color without breaking text assertions, provided the *model* keeps returning roles and only the
  *screen* turns them into escapes.
* Today the header (row 0) and the footer (last row) use inverse. The selected list row is inverse
  too. The section titles `Peers` and `Output` are bold. Between the list and the detail there is
  one blank line.
* Row indices that tests hard-code: row 0 is the header, row 1 is `Peers`, and the list starts at
  row 2 (`tui.test.ts` and `ui.test.ts` use `frame()[2]` and `frame()[3]`). The new layout keeps
  these indices (§2.2), so only the *contents* of the expected strings change.
* `printable()` removes control characters from all wire text (summaries, titles, tails). Every
  new span must still go through it. Styles come from roles, never from wire text.
* `charWidth` counts the Nerd Font MD private-use range and emoji as 2 columns. The box-drawing
  (`─`) and block (`█░`) characters are East-Asian *Ambiguous* width. They are already used only
  when `glyphs === "nerd"`, and the new chrome follows the same rule (§3.4).
* `detectGlyphs(env, hasNerdBee)` reads `SKEP_TUI_GLYPHS` and `SKEP_TUI_ASCII`, and
  `ui.ts` calls it in two places: `joinViewFactory` and `uiCommand`. Theme detection goes in the
  same two places.
* `VERSION` is a private `const` in `src/cli/program.ts` (`"0.1.2"`). `program.ts` imports the
  commands, so `tui.ts` cannot import from `program.ts` without an import cycle.
* `session.test.ts` checks `JoinViewModel` objects, not frames, so this work does not affect it.

---

## 1. Product goal and principles

The `skep ui` and `skep session join --ui` screens should feel as finished as the agent TUIs
people use next to them (pi, Codex CLI, Claude Code):

1. **Hierarchy first.** The eye goes header → peers → selected item → output → keys. The order
   comes from weight and color, not from boxes.
2. **Terminal-native Material.** Use foreground color and weight. Fill no backgrounds. Inverse
   is used **only for the selected row** (decision in §2.4).
3. **Never color alone.** Every state has a word or glyph as well (`blocked` + `!`, `done (1
   failed)`). The screen reads correctly with `NO_COLOR` and on a monochrome terminal.
4. **Calm by default.** Most text uses the default foreground. Accent colors are for things
   that need attention (blocked, failed) or action (key hints, selection).
5. **Keep the bee.** `beeLane`, `progressBar`, `detectGlyphs`, `NF_MD_*` and `charWidth` keep
   their names, signatures and output. The bee only gets color.
6. **Zero new dependencies, unchanged session protocol, `MIN_ROWS = 24`.**

---

## 2. Layout

### 2.1 Wireframe (80×24, Nerd glyphs, sub view)

```text
 󰾡 skep   session joined · device laptop · role coding                   v0.1.5   ← 0 header
── PEERS ─────────────────────────────────────────── 3 peers · 1 working · 1 blocked ← 1 rule
  laptop   coding    󰾡     [████░░░░]  50%  4/8  working  add a health check   ← 2 strip
> laptop   coding    I-3 e1  claude/pty  running                                ← 3 selected (inverse)
  vps      backend   󰾡!    [██████░░]  75%  6/8  blocked  migrate users       ← 4
  mac      frontend  󰳏     [████████] 100%  8/8  done (1 failed)              ← 5
                                                                                ← 6–7 (list room, ≤ 6 rows)
── ITEM ─────────────────────────────────────────────────────── I-3 · epoch 1 ← 8 rule
  Item    I-3 (web)  add a health check                                         ← 9
  Agent   claude · view pty · running                                           ← 10
  Submit  policy ask                                                            ← 11
  ! focus failed (exit 1); run it yourself: herdr focus 3                       ← message (tone)
── OUTPUT ──────────────────────────────────────────────────── last 9 of 120 ← rule
    …tail line…                                                                 ← tail fills
    …tail line…
 a/⏎ attach · ↑↓ select · q quit                                            2/4 ← 23 footer
```

ASCII glyph mode: the rules use `-`, the bar uses `#`/`.`, the bee uses `~b>`, the header has no
icon, and `⏎` is written `enter`. The `↑↓` arrows in the footer exist today in both modes and
stay.

### 2.2 Row budget (why `MIN_ROWS` stays 24)

| Block | Rows | Notes |
|---|---|---|
| Header | 1 | |
| `PEERS` rule | 1 | Replaces the bold `Peers` line, so it is still row 1. |
| List | 1–6 | `MAX_LIST_ROWS = 6` is unchanged. |
| Overflow hint | 0–1 | `+N more · ↑↓ to scroll`, muted. |
| `ITEM` rule | 1 | Replaces today's blank separator line, so no extra row. |
| Detail | 2–5 | Item, Agent, the blocked/attach/watch hints, Submit. |
| Message | 0–1 | |
| `OUTPUT` rule | 1 | Replaces the bold `Output` line. |
| Tail | ≥ 5 | Fills the rest of the screen. |
| Footer | 1 | |

Worst case: 1+1+6+1+1+5+1+1+1 = 18 fixed rows, which leaves 6 rows of tail at 24 rows. That is
one row *more* than today, because the blank line turned into a labeled rule. **`MIN_ROWS` stays
24.** Below 24 rows the "terminal too small" notice stays. It gets the error role and also
names the fix (`resize to ≥ 24 rows`).

### 2.3 Column rules (responsive inside one layout)

* The device column is padded to the widest device name, capped at 12 columns. The role column
  is padded the same way, capped at 10. This aligns the strips and items into columns (pi and
  Codex both align their status lists). Names longer than the cap are truncated with `…`.
* The strip keeps today's field order: `device role lane [bar] pct% done/total phase summary`.
* Shedding order when a strip is too wide: drop the summary, then the `done/total` field below
  70 columns, then the bar below 60 columns (the percentage stays). Truncation with `…` is the
  last resort and is still applied by `Screen.draw`.
* The header puts `left` and `right` segments on one line. When they do not fit, the right
  segment (version) is dropped first, then the `role` label, then the left side is truncated.
* A rule's right label (counts, `I-3 · epoch 1`, `last 9 of 120`) is dropped when the rule would
  have fewer than 4 `─` characters left.
* The footer keeps the keys on the left and the selection position (`2/4`, only when there is
  more than one entry) on the right. It is padded to the full width (the current test
  `plainFrame()[23]` with length 80 keeps passing).

### 2.4 Inverse and emphasis decisions

| Element | Today | New | Why |
|---|---|---|---|
| Header | inverse bar | `skep` in **primary bold**; labels `on-surface-variant`; values `on-surface`; version `outline` | Inverse bars are heavy and compete with the selection. Claude Code and Codex headers use plain text with an accent. |
| Section titles | bold `Peers`/`Output` | `outline` rule plus a `on-surface-variant` **bold** uppercase label | A title and a separator in one row. |
| Selected row | inverse + `> ` | unchanged: inverse + `> ` | The one place the constraint allows. It works the same with and without color. |
| Footer | inverse bar | no inverse; keys `primary` **bold**, labels `on-surface-variant`, separator `·` in `outline` | Codex and Claude Code footers are dim hint lines, not bars. Keeping inverse only for the selection means "highlighted" always means "selected". |

Under `NO_COLOR` the footer keys stay **bold** and the labels plain, so the footer is still
distinct from the tail without inverse.

### 2.5 Components

1. **Header**: the `NF_MD_BEEHIVE` icon (nerd only) and `skep` in primary, then
   `session <id> · device <d> · role <r>`, with the version on the right.
2. **Section rule** `rule(label, right?)`: `── LABEL ───── right ─`.
3. **Peer strip**. The bee lane gets the phase color (working → primary, blocked → warning,
   done → success, idle → outline). In the bar, the filled cells are primary (error when
   `failed > 0` and the phase is `done`) and the empty cells are outline. The percentage is bold,
   `done/total` is variant, the phase chip uses the phase color, and the summary is on-surface.
4. **Status chip** `chip(state)`: one table maps every peer phase, agent state and item state
   to a role plus the word itself (§3.3). It is the only place states get colors.
5. **Item detail**: fixed 6-column labels in variant (`Item`, `Agent`, `Submit`), values in
   on-surface, the agent state as a chip. The blocked hint becomes
   `! answer in the agent's own view — press a` in warning. The ready-to-attach hint is in
   primary.
6. **Message line** (toast): `model.message` gets a tone, `info` (secondary) or `error`
   (error, prefixed `! `). Focus failures and host-read failures are `error`.
7. **Output pane**: the tail is indented 4 columns and uses on-surface. The rule's right label
   says `last N of M` when lines are hidden.
8. **Footer**: only the keys that do something now (existing `footerKeys()` logic). Key in
   primary bold, label variant, `·` separators. Pending submit keys (`p pr · u push · n none ·
   s skip`) use warning for the keys, because a choice is waiting.
9. **Empty states** (muted, one line each, no blank screen):
   * no peers: `Waiting for peers — run skep session join on another device`
   * no item: `No item yet — the master has not assigned work to this device` (sub) /
     `No items yet` (master)
   * no output: `No output yet`

---

## 3. Design tokens (our DESIGN.md)

### 3.1 Derivation

Source color: honey `#FFC430`. Following M3, the dark scheme takes `primary` from tone ~80 of
the source palette and the light scheme from tone ~40. The neutral roles come from a neutral
palette (tone 90 text / 70 variant / 60 outline in dark, tone 10 / 30 / 50 in light). We do not
paint surfaces: `surface` is the terminal's own background. So only *foreground* roles are
tokens, and contrast is measured against a reference background (`#1E1E1E` dark, `#FFFFFF`
light).

The "dark/light" choice is a *palette* choice. It can only be guessed (§4.3), because reading
the real terminal background (OSC 11) is asynchronous and unreliable through tmux/ssh.

### 3.2 Token table

`16` is the SGR used with 16 colors. `none` is what is left under `NO_COLOR` /
`SKEP_TUI_COLOR=never` (attributes only; NO_COLOR forbids color, not weight).

| Token | Meaning | Truecolor dark | Truecolor light | 256 dark / light | 16 | none |
|---|---|---|---|---|---|---|
| `primary` | brand, key hints, active/working, bar fill | `#FFC430` | `#7A5900` | 220 / 136 | `93` (bright yellow) | bold |
| `on-surface` | body text, values | default fg (`39`) | default fg | default | default | — |
| `on-surface-variant` | labels, hints, metadata | `#A8ADB3` | `#4A4F55` | 248 / 240 | `2` (dim) | dim |
| `outline` | rules, separators, empty bar cells, version | `#80868B` | `#757A80` | 244 / 245 | `2` (dim) | dim |
| `secondary` | info toasts, device names when a peer is live | `#7FD3F7` | `#00658A` | 117 / 24 | `96` (bright cyan) | — |
| `tertiary` | agent CLI / view names | `#D7A6E8` | `#7A3E8F` | 182 / 96 | `95` (bright magenta) | — |
| `success` | done | `#8BD49E` | `#1E6B34` | 114 / 28 | `92` (bright green) | — |
| `warning` | blocked, a choice is pending (needs the human) | `#FF9E57` | `#9A4600` | 215 / 130 | `33` (yellow) | bold |
| `error` | failed, left, too-small notice | `#FF8A80` | `#B3261E` | 210 / 124 | `91` (bright red) | bold |
| `selection` | selected list row | inverse (`7`) | inverse | inverse | inverse | inverse |

Every SGR span ends with `ESC[0m`, so a cut line never leaks style into the next one.

The `primary` and `warning` colors are close with 16 colors (bright yellow vs yellow). That is
acceptable because warning text always has a `!` glyph or the word `blocked` next to it (§1.3).

### 3.3 State → role map (single source: `chip()`)

| State (source) | Role | Glyph/word kept in plain text |
|---|---|---|
| peer `working` | primary | bee lane + `working` |
| peer `blocked` | warning | `!` + `blocked` |
| peer `done`, `failed = 0` | success | hive + `done` |
| peer `done`, `failed > 0` | error (the "(N failed)" part only) | `done (N failed)` |
| peer `idle` / no progress | on-surface-variant | `.` + `idle` / state text |
| agent `starting` | on-surface-variant | `starting` |
| agent `running` | primary | `running` |
| agent `blocked` | warning | `blocked` |
| agent `done` | success | `done` |
| agent `failed` | error | `failed` |
| item states from the master (`open`, `claimed`, `done`, `failed`, …) | variant / primary / success / error | the state word |
| unknown string | on-surface | as-is |

### 3.4 Glyph tokens

| Token | nerd | ascii |
|---|---|---|
| rule | `─` | `-` |
| separator | ` · ` | ` · ` → ` | ` in ascii |
| bar full / empty | `█` / `░` | `#` / `.` (unchanged) |
| header icon | `NF_MD_BEEHIVE` + space | none |
| enter key | `⏎` | `enter` |
| bee lane | unchanged (`beeLane`) | unchanged |

`·` (U+00B7) is ambiguous width too, so the ascii mode uses `|`. That keeps ascii mode the
"safe on any terminal / CJK locale" choice that `peer-progress-bee.md` §4.5 promises.

### 3.5 Contrast targets

* Text roles (`primary`, `on-surface-variant`, `secondary`, `tertiary`, `success`, `warning`,
  `error`): WCAG contrast **≥ 4.5:1** against the reference background of their scheme.
* `outline` (non-text: rules and empty bar cells; the version also uses it but is redundant
  information): **≥ 3:1**.
* These are checked by a unit test (§6.1) with a small, pure WCAG relative-luminance function
  in `theme.ts`. The hex values in §3.2 are starting points. If the test finds one below
  target, the implementer moves the tone and updates this table in the same commit.

---

## 4. Theme module and environment

### 4.1 `src/cli/theme.ts` (new)

```ts
export type ColorLevel = "none" | "16" | "256" | "truecolor";
export type Scheme = "dark" | "light";
export type Role =
  | "primary" | "on-surface" | "on-surface-variant" | "outline"
  | "secondary" | "tertiary" | "success" | "warning" | "error";

export interface Theme {
  level: ColorLevel;
  scheme: Scheme;
  glyphs: Glyphs;                 // from detectGlyphs; drives §3.4
  /** SGR prefix for a span; "" when nothing applies. Never contains wire text. */
  sgr(span: { role?: Role; bold?: boolean; dim?: boolean; inverse?: boolean }): string;
}

export function detectColorLevel(env: NodeJS.ProcessEnv, isTty: boolean): ColorLevel;
export function detectScheme(env: NodeJS.ProcessEnv): Scheme;
export function createTheme(opts: { level: ColorLevel; scheme: Scheme; glyphs: Glyphs }): Theme;
export function contrastRatio(fgHex: string, bgHex: string): number; // for tests and docs
export const PALETTE: Record<Scheme, Record<Role, { hex: string | null; x256: number | null; x16: string | null; attr?: "bold" | "dim" }>>;
```

All of these are pure functions of their arguments (no `process.env` default inside
`detectColorLevel`; the callers in `ui.ts` pass `ctx.env`). The module exports no `Date`, no
I/O.

### 4.2 Color level detection (first match wins)

1. `SKEP_TUI_COLOR=never|none|0` → `none`; `=16`, `=256`, `=truecolor|24bit` → that level;
   `=auto` or unset → continue. (An explicit skep setting overrides NO_COLOR, which is what
   no-color.org allows for user-level config.)
2. `NO_COLOR` set and non-empty → `none` (no-color.org).
3. `FORCE_COLOR` = `0` → `none`; `1` → `16`; `2` → `256`; `3` → `truecolor` (Node/chalk
   convention).
4. `!isTty` → `none` (only matters for tests and odd embeddings; `skep ui` already requires a
   TTY).
5. `TERM=dumb` → `none`.
6. `COLORTERM` is `truecolor` or `24bit` → `truecolor`.
7. `TERM` contains `256color` (also `xterm-kitty`, `wezterm`, `alacritty`) → `256`.
8. Otherwise `16`.

tmux: tmux sets `TERM=tmux-256color`/`screen-256color` and passes `COLORTERM` through only when
the user configured it. So the result is `256` unless the user enabled RGB. That is correct and
needs no special case.

### 4.3 Scheme detection

1. `SKEP_TUI_THEME=dark|light` → that scheme; `auto` or unset → continue.
2. `COLORFGBG` (set by rxvt, Konsole, some others, e.g. `15;0`): a last field of `7` or `15`
   (light background) → `light`; anything else → `dark`.
3. Default `dark`.

### 4.4 Environment variables (migration notes)

| Variable | Status | Values | Effect |
|---|---|---|---|
| `SKEP_TUI_GLYPHS` | existing, unchanged | `nerd`, `ascii`, `unicode` (alias of nerd) | glyph set (bee, bar, and now rules/separators/icons) |
| `SKEP_TUI_ASCII` | existing, **kept as a legacy alias** | `1` | same as `SKEP_TUI_GLYPHS=ascii`. It is documented as legacy, but it is not removed and does not warn: scripts from 0.1.3 keep working. |
| `SKEP_TUI_COLOR` | **new** | `auto` (default), `never`, `16`, `256`, `truecolor` | color level override (§4.2) |
| `SKEP_TUI_THEME` | **new** | `auto` (default), `dark`, `light` | palette (§4.3) |
| `SKEP_TUI_ANIMATE` | **new** | `1` (default), `0` | `0` turns off the bee ticker (reduced motion, slow links, screen recorders). It maps to the existing `TuiOptions.animate`. |
| `NO_COLOR` | **newly honored** | any non-empty | color level `none` unless `SKEP_TUI_COLOR` is set |
| `FORCE_COLOR` | **newly honored** | `0`–`3` | color level (§4.2 step 3) |
| `COLORTERM`, `TERM`, `COLORFGBG` | read | — | detection only |

Behavior changes users will notice:

* The header and footer are no longer inverse bars. That is intended. There is no switch back:
  a legacy-look flag would double the frame tests for little value.
* With `NO_COLOR` set, the screen is the same as today except for those two bars, plus bold/dim
  hierarchy.
* Row positions are unchanged. The strings change (aligned columns, `·` separators,
  uppercase section labels). Anyone scraping the alternate screen should not; it was never an
  interface.
* No config file keys: these are display preferences and belong in the environment, like
  `SKEP_TUI_GLYPHS`.

---

## 5. File change list

| File | Change |
|---|---|
| `src/cli/theme.ts` (new) | §4.1: roles, palette, `detectColorLevel`, `detectScheme`, `createTheme`, `contrastRatio`. No I/O. |
| `src/cli/theme.test.ts` (new) | §6.1. |
| `src/cli/version.ts` (new) | `export const SKEP_VERSION = "0.1.2";` (the release task bumps it). |
| `src/cli/program.ts` | Use `SKEP_VERSION` from `./version.js` instead of the local `VERSION` const. Only that change. |
| `src/cli/tui.ts` | (a) `Line` becomes `string \| { spans: Span[]; selected?: boolean; fill?: boolean }` with `Span = { text; role?; bold?; dim? }`. Plain strings still work. The old `{text, style}` form is removed after the model stops using it. (b) `Screen` takes a `Theme` (default: `createTheme({level:"none", scheme:"dark", glyphs:"ascii"})`), truncates across spans by display width, runs `printable` on each span, emits `theme.sgr()` + text + `RESET` per span, and pads selected/fill lines to the width. (c) `TuiModel` builds the §2 layout: `header()`, `rule()`, `chip()`, aligned `listRows()` with spans, `detail()` with labels, message tone, `footer()` with right segment, empty states, the shedding rules in §2.3. (d) `progressBarParts(percent, glyphs) → {filled, empty}`; `progressBar` stays as their join (same output). (e) `TuiOptions.theme?: Theme`. **Unchanged:** `beeLane`, `progressBar` output, `detectGlyphs`, `nerdBeeFontInstalled`, `NF_MD_*`, `charWidth`, `decodeKeys`, key handling, terminal restore paths, `MIN_ROWS`, `MAX_LIST_ROWS`, `TICK_MS`. |
| `src/cli/tui.test.ts` | Update the expected strings; add the tests in §6.2. |
| `src/cli/__snapshots__/tui.test.ts.snap` (new, generated) | Golden frames (§6.2). |
| `src/cli/commands/ui.ts` | Build one `Theme` from `ctx.env` (`detectColorLevel(ctx.env, stdout.isTTY === true)`, `detectScheme`, `detectGlyphs`) in a small `themeFromEnv(ctx)` helper. Pass it plus `animate: ctx.env.SKEP_TUI_ANIMATE !== "0"` to both `new Tui` and `new TuiJoinView`. `masterSnapshot` is **unchanged**. |
| `src/cli/commands/ui.test.ts` | Update the expected strings (`frame()[0]`, `slice(1,4)`, the strip asserts); add the env plumbing tests in §6.3. |
| `README.md` | The TUI section: a screenshot-style text block, the env var table from §4.4. |
| `CHANGELOG.md` | `[Unreleased]` → `Changed`: the TUI redesign; `Added`: `SKEP_TUI_COLOR`, `SKEP_TUI_THEME`, `SKEP_TUI_ANIMATE`, NO_COLOR/FORCE_COLOR support. |

**Not touched:** `src/session/**` (protocol), `src/cli/commands/session.ts` (`JoinView`,
`JoinViewModel`, the status schema copy), `package.json`, configs, `src/core/**`.

---

## 6. Test plan

Everything is deterministic: fake terminals at fixed sizes, the injected clock, `animate:
false` unless the ticker is under test, and env objects passed in (never `process.env`).

### 6.1 `theme.test.ts`

* `detectColorLevel` table test that covers every rule in §4.2, including precedence:
  `SKEP_TUI_COLOR=256` + `NO_COLOR=1` → `256`; `NO_COLOR=1` + `FORCE_COLOR=3` → `none`;
  `NO_COLOR=""` → ignored; `TERM=dumb` → `none`; `COLORTERM=truecolor` → `truecolor`;
  `TERM=tmux-256color` → `256`; `TERM=xterm` → `16`; not a TTY → `none`.
* `detectScheme`: `SKEP_TUI_THEME`, `COLORFGBG=15;0` → dark, `0;15` → light, `0;default;15`
  → light, garbage → dark.
* `sgr()` for each level: truecolor emits `38;2;r;g;b`, 256 emits `38;5;n`, 16 emits the §3.2
  code, `none` emits only `1`/`2`/`7` and **never** a `3x`/`9x`/`38` code (checked by a regex
  over every role × flag combination).
* Contrast: every text role ≥ 4.5 and `outline` ≥ 3 against `#1E1E1E` (dark) and `#FFFFFF`
  (light). Also `contrastRatio("#FFFFFF", "#000000") === 21` to pin the formula.
* The 256-color indices are the nearest xterm-256 color to the hex value (a helper in the test
  computes the nearest one; this keeps §3.2 honest when someone edits a hex).

### 6.2 `tui.test.ts`

Existing tests: update the expected strings for the new header, rule labels, aligned columns,
detail labels and footer. Every assertion that is about *behavior* stays (keys, attach,
submit, restore paths, ticker, truncation, the 24-row minimum).

New tests:

1. **Layout rows at 80×24**: row 0 header, row 1 `PEERS` rule, the list from row 2, an
   `ITEM` rule, an `OUTPUT` rule, footer at row 23; `frame()` length 24.
2. **Width invariant**: for nerd and ascii, at 80×24, 100×40 and 60×24, with long device
   names, long titles and emoji in summaries, every plain line's display width (`charWidth`) is
   ≤ columns, and the footer and selected row are exactly `columns`.
3. **Inverse discipline**: in a raw frame with color on, `ESC[7m` occurs exactly once (the
   selected row), and not at all when there are no entries. The header and footer contain no
   `7`.
4. **Roles reach the screen**: with a truecolor theme, the working phase chip, a blocked strip
   (`warning`), a done strip (`success`) and a `done (1 failed)` strip (`error`) carry the
   expected `38;2;…` prefix. The bee lane gets its phase color, and the bar's filled and empty
   cells get primary and outline.
5. **NO_COLOR frame**: with a `none` theme, the raw frame contains no `3x`/`9x`/`38` SGR. The
   footer keys are bold (`1`). The plain text is identical to the truecolor frame's plain text
   (color never changes content).
6. **Wire text cannot style**: a summary/title/tail containing `\x1b[31m` and `\x1b[7m`
   renders without those sequences (extends today's control-strip test to spans).
7. **Glyph chrome**: ascii frames contain no `─`, `·`, `█`, `░` or PUA code points. Nerd frames
   use `─` rules and the beehive header icon.
8. **Shedding** (§2.3): at 70 columns the summary is gone; at 60 the bar is gone and the
   percentage stays; a long header drops the version first.
9. **Empty states**: no peers, no item (sub and master wording), no output. Each is one muted
   line.
10. **Message tone**: a failed herdr focus shows `! focus failed …` with the error role; the
    host-read failure is also error.
11. **Footer**: right segment `2/4` only with more than one entry; the pending-submit keys use
    the warning role.
12. **Golden snapshots** (`toMatchSnapshot`): four frames — {nerd, ascii} × {truecolor, none}
    — of one fixed scene (3 peers working/blocked/done, 2 entries, a pending submit, 30 tail
    lines). Escapes are made visible by replacing `\x1b` with `⎋` so diffs are readable in
    review. These snapshots are the visual contract; changing them needs a reviewer.
13. **Bee unchanged**: the existing `beeLane`/`progressBar`/`detectGlyphs` tests run unmodified.

### 6.3 `ui.test.ts`

* `skep ui` with `env: { NO_COLOR: "1" }` → no color SGR in the output; with
  `SKEP_TUI_COLOR: "truecolor"` → `38;2;` present.
* `SKEP_TUI_ANIMATE: "0"` with a working peer → the fake clock is never asked to sleep for
  `TICK_MS`.
* `joinViewFactory(ctx)` with `SKEP_TUI_THEME: "light"` → the light primary hex appears.
* Existing master-view and factory tests keep checking `masterSnapshot` objects unchanged.

### 6.4 Gate

`npm run lint && npm test` green. `npm run build` succeeds.

### 6.5 Manual QA (recorded in the PR description, not automated)

Two devices (or two directories) in one session, each in `skep session join --ui`, plus
`skep ui` on the master. Check in: kitty or WezTerm (truecolor, Nerd Font), macOS Terminal.app
(256, no Nerd Font → ascii), tmux inside both, a light-background profile with
`SKEP_TUI_THEME=light`, `NO_COLOR=1`, `TERM=dumb`, an 80×24 window, a 200×60 window, resize
while working, and `a` attach/return on a PTY agent (the colors must be gone from the agent's
terminal after `suspend`, i.e. `RESET` before the alt-screen exit).

---

## 7. Implementation order (commits)

1. `feat(tui): add semantic theme tokens and color detection` — `theme.ts` + tests, no
   callers yet.
2. `refactor(tui): render span lines through the theme` — the `Line`/`Screen` change; the
   model still emits the old layout, mapped to spans (frames are byte-identical in plain text).
3. `feat(tui): material layout with rules, chips and key footer` — the `TuiModel` layout +
   updated and new tests + snapshots.
4. `feat(ui): honor SKEP_TUI_COLOR/THEME/ANIMATE and NO_COLOR` — `ui.ts`, `version.ts`,
   `program.ts`, ui tests.
5. `docs: document the TUI theme and env vars` — README, CHANGELOG.

Each commit leaves `npm run lint && npm test` green.

---

## 8. Acceptance checklist (vs pi / Codex / Claude Code feel)

Layout and hierarchy

- [ ] One-line header with the brand accent and session/device/role context; no inverse bar
      (Claude Code / Codex style).
- [ ] Sections separated by labeled thin rules, not boxes or blank lines.
- [ ] The peer strips and items line up in columns at any device/role name length up to the caps.
- [ ] The selected row is the only inverse element on screen.
- [ ] The output pane fills the remaining height and says when lines are hidden.
- [ ] Empty states say what is happening and what to do next.

Status

- [ ] Each peer/agent/item state has one color from the `chip()` table *and* a word/glyph.
- [ ] Blocked is visible from across the room (warning + `!` + animated bee pulse), and its hint
      says which key to press.
- [ ] Failures show in error color both in the strip (`done (N failed)`) and as `! …` toasts.

Shortcuts

- [ ] The footer shows only keys that act now, with the key emphasized and a muted label (Codex /
      Claude Code footer hint style). Pending choices use warning keys.
- [ ] The footer shows position `n/m` when the list can scroll.

Robustness

- [ ] `NO_COLOR`, `TERM=dumb`, `SKEP_TUI_COLOR=never`: same content, no color codes.
- [ ] 16 / 256 / truecolor all readable on dark; `SKEP_TUI_THEME=light` readable on white.
- [ ] Contrast test passes (text ≥ 4.5:1, outline ≥ 3:1).
- [ ] Nerd bee (`nf-md-bee` / `bee-flower` / `beehive`) still animates; the ascii fallback and
      `detectGlyphs` are unchanged; ascii mode has no ambiguous-width chrome.
- [ ] No line exceeds the terminal width at 60, 80, 100, 200 columns; resizing redraws cleanly.
- [ ] `MIN_ROWS` is 24, the session protocol is unchanged, there are no new dependencies.
- [ ] Wire text can never inject style (control strip per span).
- [ ] Leaving for a PTY agent and quitting both restore a clean, uncolored terminal.

---

## 9. Non-goals

* Mouse support, a scrollback/pager for the tail, split panes, alternate layouts below 24 rows.
* Querying the terminal background color (OSC 11) or the font.
* A config-file theme or user-defined palettes (the env vars cover 0.1.5; tokens are centralized
  so this can come later).
* Any change to the session wire protocol, `JoinViewModel`, or `progress` messages.

## 10. Open questions (do not block the implementation)

* Should `skep ui` on the master show "updated Ns ago" in the footer right? It needs the clock
  in the model. Deferred; the `n/m` position takes the slot for now.
* Should the header show connection health for a sub (`● connected` / `reconnecting`)? It
  needs a `JoinViewModel` field, which is owned by `session.ts`, so it is out of scope here.
