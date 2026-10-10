# Plan: Unified Skep TUI shell (Grok Build–style) — 0.1.6

Status: **plan ready for implementation.** Branch: `feat/unified-tui-shell`, cut from `main` @ 0.1.5.
Do **not** bump `package.json` / `SKEP_VERSION` until the release task. Target tag: **0.1.6**
(parent confirms before npm publish).

Sources:

* Brief: `docs/plans/unified-tui-shell-BRIEF.md` / `/tmp/skep-unified-tui-brief.md`
* Grok Build UX: welcome + prompt + `/` fuzzy menu + scrollback
  (https://grok-wiki.com/…/22-slash-commands.md; pager `welcome/` + `prompt_widget`)
* Prior plans: `tui-material-redesign.md`, `peer-progress-bee.md`
* Code: `src/cli/tui.ts`, `theme.ts`, `version.ts`, `program.ts`,
  `commands/agent-tui.ts`, `session.ts`, `ui.ts`

---

## 0. Facts from the current code this plan depends on

* Bare `skep` / `skep tui` call `launchAgent` → **replaces** the process with Claude/Codex/pi’s
  own fullscreen TUI (`agent-tui.ts`). That is the behaviour we remove from the default path.
* Session monitor UI lives in `TuiModel` + `Screen` (`tui.ts`). It has **no text input**, no
  scrollback of free-form events, no slash menu. Bee strips sit in the PEERS list.
* `skep session start` / `join` / `intent` / `status` / `join --ui` / `skep ui` already work.
  JoinView streams item tails into `TuiModel`. Progress uses `progress` messages (0.1.5).
* `Screen` owns alt-screen, raw mode, full redraw. `MIN_ROWS = 24`. Theme roles in `theme.ts`.
  Glyphs: Nerd Font bee with ASCII fallback. **No new npm dependencies.**
* `VERSION` is `src/cli/version.ts` (`SKEP_VERSION`). Do not import `program.ts` from TUI.
* AGENTS.md: English only; Clock for protocol timers; stay in owned files; lint+test green;
  conventional commits; never push from agent worktrees.

---

## 1. Product goal

Every `skep` open draws **the same Skep shell**:

1. Logo + basic info (version, device, cwd, session state).
2. Scrollback / main pane for **all** Skep output.
3. Input box at the bottom; `/` opens built-in slash commands (`/start`, `/join`, …).
4. Bee + peer progress **under the input**, when a session is live.
5. Default happy path **never** hands the terminal to Claude/Codex fullscreen.
   Explicit attach (`a` / herdr) remains an escape hatch for PTY agents.

---

## 2. Wireframes (80×24)

### 2.1 Cold start / welcome (no session)

```text
  󰾡  skep                                          v0.1.6
  device  laptop · cwd  ~/proj · no session

  Welcome. Type a goal, or / for commands.
  /start          start a local session master
  /join <code>    join a session (same machine or --host)
  /help           list commands

  (scrollback grows above as events appear)




> _                                                              ← input (row 21)
  ─────────────────────────────────────────────────────────────
  (no peers yet)                                                 ← bee footer (row 22–23)
  / commands · enter send · ctrl+c clear · q via /quit
```

ASCII mode: logo is `skep` wordmark without Nerd glyph; rules use `-`.

### 2.2 Slash menu open

```text
  …scrollback…

> /jo_                                                           ← input
  ┌ /join <code> [host]   join a session by code               ┐ ← dropdown (above input)
  │ /quit                 leave the shell                        │
  └────────────────────────────────────────────────────────────┘
  (peers / idle footer)
```

Fuzzy filter on the token after `/`. ↑↓ select, Tab/Enter accept (insert + trailing space if
args required), Esc closes menu and keeps the draft.

### 2.3 Live session (master or joined sub)

```text
  󰾡  skep   session live · master · code 4821-…-5520           v0.1.6
  device  laptop · role coding · peers 2

  10:02  session started on 0.0.0.0:7419
  10:02  join code 4821-0937-5520  (peers: skep session join --code …)
  10:03  peer vps joined (frontend)
  10:03  intent: redesign auth middleware
  10:04  I-1 → vps  working  extract handlers
  10:05  I-1 tail: …
  …

> implement the remaining checks_                              ← input
  ─────────────────────────────────────────────────────────────
  laptop  coding  󰾡   [████░░░░] 50% 2/4 working  extract…     ← bee strips
  vps     frontend ·  [██░░░░░░] 25% 1/4 working  forms
  enter send · / commands · a attach · q /quit
```

Bee footer is **1 row per peer** (cap 3 visible + `+N more`), always below the input.
Input stays focusable while work runs; scrollback appends session / agent events.

---

## 3. Information architecture

| Region | Rows (budget) | Focus | Notes |
|---|---|---|---|
| Header | 2 | never | logo, version, session chip, device/cwd |
| Scrollback | `rows - header - input - bee - hint` | optional (pgup/pgdn) | ring buffer of lines; newest at bottom |
| Slash dropdown | up to 6 | when `/` menu open | overlays bottom of scrollback |
| Input | 1 | **default** | prompt `>`; editable buffer |
| Rule | 1 | never | separator |
| Bee footer | 0–3 | never | peer progress strips; hidden if no session |
| Hint | 1 | never | contextual key help |

**Focus model:** input is primary. Slash dropdown steals ↑↓/Tab/Enter/Esc while open.
PgUp/PgDn scroll the scrollback without leaving input focus (Codex-like). `a` attach only when
a PTY item is pending (existing semantics).

**Z-order:** dropdown above scrollback; input+bee+hint always visible (never covered).

---

## 4. Slash command registry

New module: `src/cli/shell/slash.ts`.

```ts
export interface SlashCommand {
  name: string;                 // "start"
  aliases?: string[];           // ["exit"] for quit
  description: string;
  usage?: string;               // "<code> [--host host:port]"
  argsRequired?: boolean;
  /** Return false to hide from menu (still runnable if fully typed). */
  visible?: (ctx: ShellCtx) => boolean;
  run: (ctx: ShellCtx, args: string) => Promise<SlashResult> | SlashResult;
}
export type SlashResult =
  | { type: "ok"; message?: string }
  | { type: "error"; message: string }
  | { type: "quit" };
```

### 4.1 MVP commands

| Command | Maps to | Behaviour |
|---|---|---|
| `/start` | `session start` internals | Start master in-process (or ensure local master); print join code into scrollback; update header + bee footer. |
| `/join [code] [--host h:p]` | `session join` | Join; if code omitted and local `session.json` exists, join local master. Start progress subscription. |
| `/status` | `session status` | Dump status block into scrollback. |
| `/intent <text>` | `session intent` | Submit intent when master reachable. |
| `/help` | local | List visible commands. |
| `/quit` (`/exit`) | local | Clean shutdown (leave session, restore terminal). |
| `/agent [claude\|codex\|pi]` | local | Set preferred agent for **session work items** (not fullscreen takeover). |

**Unknown `/foo`:** show `unknown command: /foo — try /help` in scrollback (MVP). Once free-form
agent turns exist in a later release, switch to Grok-style pass-through; document the switch.

**Dispatch rule:** slash handlers call **extracted session functions** (same code paths as CLI
subcommands), not `spawn("skep", …)`. Refactor `session.ts` so `startMasterFlow` / `joinFlow`
are importable without Commander.

### 4.2 Fuzzy menu

* Trigger: buffer matches `^/(\S*)$` (no space yet) or `^/(\S+)\s` for arg hints.
* Rank by prefix then subsequence (simple; no new deps).
* Show ≤ 6 rows: `/{name}  {usage?}  {description}`.

---

## 5. Agent output without stealing the terminal (MVP)

**Chosen approach: session-item path only (reuse JoinView tails).**

* Free-form text in the input that is **not** a slash command is treated as:
  - if a live session master is reachable → `session intent "<text>"` (existing planner);
  - else → scrollback hint: `no session — /start or /join first` (MVP; no local solo agent yet).
* Agents keep running under `session join`’s existing workItem / PTY-or-herdr runners.
  Their stdout already becomes item `tail` lines → now also mirrored into shell scrollback.
* **Do not** call `launchAgent` from the default `skep` action.
* Keep `skep tui --agent …` as an **explicit** escape to the old fullscreen agent launch
  (documented in `/help` as advanced). Rename description to “open the raw agent TUI”.

**Tradeoffs**

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| A. Session items + tails (chosen) | Reuses protocol; multi-device; bee already wired | No solo chat without session | MVP |
| B. Headless agent pipe into scrollback | Solo use | New runner, approve UX, duplicates session | Later |
| C. Keep launching agent TUI | Zero work | Violates product requirement | Rejected |

---

## 6. Module layout and file ownership

### 6.1 New files

| File | Owner | Responsibility |
|---|---|---|
| `src/cli/shell/model.ts` | Codex | `ShellModel`: header, scrollback ring, input buffer, slash menu state, bee peers, `frame()` |
| `src/cli/shell/slash.ts` | Codex | registry, fuzzy match, MVP command defs (handlers injected) |
| `src/cli/shell/input.ts` | Codex | key decode → edit buffer / menu / scroll (pure where possible) |
| `src/cli/shell/run.ts` | Claude | `runShell(ctx)`: Screen loop, wire slash → session flows, progress → bee, cleanup |
| `src/cli/shell/logo.ts` | Codex | logo / welcome lines (nerd + ascii) |
| `src/cli/shell/*.test.ts` | same owners | frame + input + slash unit tests |

### 6.2 Modified files

| File | Owner | Change |
|---|---|---|
| `src/cli/program.ts` | Claude | Default action → `runShell`; keep `tui` register |
| `src/cli/commands/agent-tui.ts` | Claude | `skep tui` remains raw agent; update description |
| `src/cli/commands/session.ts` | Claude | Export `startMasterFlow` / `joinSessionFlow` / status helpers usable from shell (no behaviour change for CLI) |
| `src/cli/tui.ts` | Codex | Export `beeLane` / `progressBar` / strip helpers for shell bee footer; avoid duplicating glyph logic. Keep `TuiModel` for `skep ui` / `join --ui` (compat). |
| `src/cli/commands/ui.ts` | Claude | Unchanged behaviour; optional note in help that shell embeds bee |
| `CHANGELOG.md` | Claude | `[Unreleased]` notes only |
| `README.md` | Claude | Quick start: open `skep`, `/start`, `/join` |

### 6.3 Unchanged

* `src/session/**` wire protocol (no new message types).
* `theme.ts` tokens (reuse).
* Website.

### 6.4 Parallelism

1. Codex implements pure shell UI (`model`/`slash`/`input`/`logo` + tests) against fakes.
2. Claude extracts session flows + `runShell` + program default action + integration tests.
3. Merge order: Codex UI branch first (or rebase), then Claude wiring, then parent review.

Branch: `feat/unified-tui-shell`. Optional split branches:
`feat/unified-tui-shell-ui` (Codex) + `feat/unified-tui-shell-wire` (Claude) → merge into feature.

---

## 7. Migration / compatibility

| Entry | After 0.1.6 |
|---|---|
| `skep` | **Unified shell** (new) |
| `skep tui [prompt]` | Raw agent TUI (old default), advanced |
| `skep session start\|join\|…` | Unchanged CLI |
| `skep session join --ui` | Unchanged monitor TUI (`TuiModel`) |
| `skep ui` | Unchanged master monitor |
| Env `SKEP_TUI_GLYPHS` / theme | Honoured in shell too |

---

## 8. Tests & acceptance

### 8.1 Unit

* `slash.test.ts` — fuzzy rank, `/join` arg parse, unknown command error, visibility.
* `input.test.ts` — insert/backspace, menu open/close, accept with args trailing space.
* `model.test.ts` — welcome frame; slash overlay; bee footer under input; scrollback ring cap;
  `MIN_ROWS` notice; ascii vs nerd logo.
* `program.test.ts` — default action invokes shell runner (inject fake), not `launchAgent`.

### 8.2 Integration (CLI level, no real network)

* Fake `SessionApi`: `/start` → scrollback contains join code; bee footer idle.
* `/join` with fake sub → peer strip updates on `onProgress`.
* Non-slash text without session → hint line; with session → intent called.

### 8.3 Acceptance checklist (parent / 联调)

- [ ] `skep` on VPS and Mac shows the **same** welcome (logo + input), not Claude/Codex chrome.
- [ ] `/start` prints join code in scrollback; second device `/join <code>` works.
- [ ] Bee strips appear **under** the input and animate while the other peer works.
- [ ] Agent/item output appears in Skep scrollback; terminal is not taken over on happy path.
- [ ] `/quit` restores terminal; `skep tui` still opens raw agent.
- [ ] `npm run lint && npm test && npm run build` green.
- [ ] No version bump until release task; then **0.1.6** + CHANGELOG.

---

## 9. Out of scope

* npm publish / git tag (parent).
* Website copy.
* Solo headless agent chat without a session.
* Full Grok slash catalog (hooks, plugins, skills, theme picker, compact, …).
* New session protocol messages.
* New npm dependencies / React-ink / blessed.
* Removing `skep ui` / `join --ui` monitor screens.

---

## 10. Implementation sequence (agents)

1. **Plan** (this file) — done.
2. **Codex:** shell UI modules + tests on `feat/unified-tui-shell-ui`.
3. **Claude:** extract session flows, `runShell`, program default, CHANGELOG/README on
   `feat/unified-tui-shell-wire` (rebase onto UI branch).
4. **Parent:** review, merge to `feat/unified-tui-shell` → `main`, 联调, then ask user before
   publishing `0.1.6`.

After merge, smoke on VPS + Mac:

```bash
skep          # welcome
# /start
# other device: skep → /join <code>
```
