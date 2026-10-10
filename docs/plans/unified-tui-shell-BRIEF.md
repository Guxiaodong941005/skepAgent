# Brief: Unified Skep TUI (Grok Build–style shell) — target 0.1.6

Status for planner: plan ONLY. Do not implement, bump version, commit, or push.
Repo: /root/skep (main @ 0.1.5). Branch suggestion: `feat/unified-tui-shell`.
Target release (parent will confirm before publish): **0.1.6**.

## Product (from user, normative)

Today `skep` with no subcommand **replaces itself with** claude/codex/pi (`agent-tui.ts`).
That is wrong for the product vision. Every `skep` open must use the **same** initial
screen — like Grok Build / Codex CLI — not a different agent’s TUI.

Required UX:

1. **One shell for every open.** `skep` (and preferably `skep tui`) always draws Skep’s own
   full-screen TUI. Logo (bee / skep wordmark) + basic info (version, device, cwd or home,
   whether a session is live) at the top. Input box at the bottom.
2. **Slash commands.** Typing `/` in the input opens built-in commands with fuzzy complete.
   MVP commands **must** include at least:
   - `/start` — start a local session master (today’s `skep session start`)
   - `/join [code]` — join by code (same-machine or with host if needed)
   - `/quit` (alias `/exit`)
   Nice-to-have in the same pass if cheap: `/help`, `/status`, `/ui` (focus session view),
   `/agent` (pick claude|codex|pi). Unknown `/foo` stays as normal prompt text or shows a
   clear error — pick one and document it (Grok Build sends unknown names through to the
   agent; prefer that once an agent turn exists).
3. **All output stays in this TUI.** Session events, agent stdout/stderr tails, join-code
   banners, errors — rendered in the scrollback / main pane of *this* screen. Do **not**
   hand the terminal over to Claude/Codex’s own fullscreen UI for the default path.
   Attaching into a PTY agent view (`a` / herdr) can remain an explicit escape hatch, but
   the default collaboration loop must not leave Skep’s shell.
4. **Bee + progress under the input box.** Peer progress strips (already in 0.1.5:
   `beeLane`, bar, phase) move to a persistent footer region **below the input**, always
   visible when a session is live. Idle peers still show a quiet strip.
5. **Reference UX:** Grok Build (welcome + prompt + `/` menu + scrollback) and Codex CLI
   (calm chrome, input-first). Keep Skep’s Material token theme from 0.1.5 (`theme.ts`).

## Non-goals (this release)

* Website redesign.
* npm publish / tag (parent does that after review).
* Blackboard / skepd (already removed).
* Full Grok-parity slash catalog (hooks, plugins, marketplace, skills).
* Rewriting the session wire protocol (reuse `progress`, `status`, join/start as-is unless
  a tiny additive field is unavoidable — call it out).

## Facts the plan must respect (read the code)

* `src/cli/commands/agent-tui.ts` — default action launches external agent TUI.
* `src/cli/tui.ts` — `TuiModel` / `Screen` / bee / Material chrome; session **monitor** UI,
  not an input prompt today. `MIN_ROWS = 24`. No new npm deps.
* `src/cli/commands/session.ts`, `ui.ts` — start/join/status/`--ui`.
* `src/cli/theme.ts`, `version.ts` (`SKEP_VERSION`).
* AGENTS.md: English only; Clock/timer rules for protocol; stay in task files; lint+test green.
* Zero new dependencies. Terminal-native only (ANSI / alternate screen). No blessed/ink/etc.

## Planner deliverable

Write `docs/plans/unified-tui-shell.md` (English). Include:

1. Product wireframes (80×24): (a) cold start / welcome, (b) slash menu open, (c) live
   session with scrollback + input + bee footer.
2. Information architecture: which panes exist, z-order, focus model (input vs scrollback
   vs slash dropdown).
3. Slash command registry design (name, args, visibility, dispatch → existing session
   commands). How `/start` and `/join` map to current CLI code paths without forking logic.
4. How agent work runs **without** taking over the terminal (pty capture into scrollback?
   headless/print mode? sub-agent via existing session join view?). Be concrete; pick one
   MVP approach and list tradeoffs. Prefer reusing session items + JoinView tails if that
   already streams output into Skep’s screen.
5. File-by-file change list + Claude (VPS) vs Codex (box/Mac) ownership for parallel work.
6. Migration: what happens to bare `skep`, `skep tui`, `skep session start|join --ui`,
   `skep ui`. Compatibility story.
7. Tests + acceptance checklist (including: same screen on every open; `/start` then
   `/join` on second peer; bee under input; output never leaves Skep TUI for happy path).
8. Branch `feat/unified-tui-shell`; version note **0.1.6** but do not bump in the plan task.
9. Out of scope list.

After writing the file: print `OK` and the path, then a short outline (≤ 30 lines).
