# Task: Redesign + fix Skep unified TUI / session reliability (post-0.1.6 UX bugs)

You are **Claude Code on the VPS**. Work in this git worktree only.
English only in code, commits, and docs. Do **not** npm publish, tag, or bump to a release
version unless the plan doc mentions a *future* target. Parent will publish later.

## Context

`@skepagent/skep@0.1.6` shipped a unified shell (`skep` → logo + input + `/` commands).
Real-device trial (Mac master + peer) hit multiple UX/reliability bugs. Re-read **latest
main / 0.1.6** code under this worktree (especially `src/cli/shell/**`, `src/cli/commands/session.ts`,
`src/session/**`, `src/cli/tui.ts`, `docs/plans/unified-tui-shell.md`) and redesign the architecture
so the shell’s session truth and the protocol’s session truth stay consistent.

## Observed bugs (must address)

1. **Shell says `no session` while a peer row is visible**  
   User opened `skep` and saw header `no session` but also a `peer-2 … idle 0%` strip. Free text
   then returned `no session — /start or /join first`. Root cause is almost certainly split brain
   between header/`sessionLive`/`master`/`join` handles vs peer list (stale model, leftover
   progress UI, or reading a session file without owning a live flow).

2. **`/intent` → `Unable to route the session intent` / `no_match` with empty peers**  
   After `/start`, `/status` showed a live session + join code but `peers: none`. Intents were
   recorded as `no_match`. Shell and master must make it obvious when no peer is connected, and
   routing must not claim success paths that cannot match. Prefer clear UX: “no peers joined —
   share join code …” rather than opaque `Unable to route`.

3. **`/join` code / host parsing**  
   User tried: `/join 192.168.30.182:7419 8632-1727-0308` and got `--code must be 12 digits`.
   Today positional[0] is treated as the code (`run.ts` joinCommand), so `host:port` is parsed as
   code. Accept ergonomic forms:
   - `/join <NNNN-NNNN-NNNN> --host <host:port>`
   - `/join --host <host:port> --code <NNNN-NNNN-NNNN>`
   - `/join <host:port> <NNNN-NNNN-NNNN>` (host-like first token + 12-digit second)
   - `/join <NNNN-NNNN-NNNN>` (local master file / same machine)
   Reject with a message that shows the expected forms.

4. **Peers disappear / session feels flaky after join**  
   Peer appeared then later `/status` showed `peers: none` while master still listening. Harden
   presence: heartbeat display, disconnect reasons in scrollback, shell peer list driven only from
   live master/sub events (not stale snapshots). Document reconnect expectations.

5. **Product expectation (keep)**  
   Every `skep` open = same shell (logo, info, input). `/start`, `/join`, `/status`, `/intent`,
   `/help`, `/quit`. Output stays in this TUI. Bee + progress under the input when session live.
   Align with Grok Build / Codex CLI interaction feel — but **reliability first** this pass.

## Process (mandatory)

### Phase A — Architecture plan (write first, then implement)

Write `docs/plans/tui-session-reliability.md` covering:

1. Root-cause analysis of bugs 1–4 with file/function pointers into current 0.1.6 code.
2. Target architecture for **single source of truth**: one `SessionController` (or equivalent)
   owned by the shell; header, peer footer, slash gating, and `/status` all read from it.
   Diagram of master vs sub ownership and what the UI may show when.
3. `/join` argv grammar + examples.
4. Intent routing UX when peers empty / repo mismatch / role mismatch.
5. File-by-file change list.
6. Tests to add (unit + golden TUI frames where needed).
7. Out of scope: website, npm publish, blackboard, version bump/publish.
8. Open questions for the parent (if any).

Print `PLAN_OK` and a ≤25-line outline when the plan file is written.

### Phase B — Implement on branch `feat/tui-session-reliability`

Implement the plan. Prefer small commits:

- `docs(plans): TUI/session reliability redesign`
- `fix(shell): single session truth for header/peers/slash gating`
- `fix(shell): accept /join host:port code forms`
- `fix(session|shell): clearer intent routing when no peers / no match`
- tests + CHANGELOG `[Unreleased]` notes (no package.json version bump)

Rules from AGENTS.md: Clock/timer for protocol timing; no new deps; lint+test+build green.

### Phase C — Hand-off doc

Write `docs/plans/tui-session-reliability-READY.md` with:

- Bugs addressed (map 1–4 → commits/files)
- How to manually verify on two devices
- Open questions / known residual risks
- Explicit: **do not publish**

End the final reply with `TASK_DONE feat/tui-session-reliability`.

## Non-goals

- Do not merge to main.
- Do not tag or `npm publish`.
- Do not change website.
- Do not remove bee/progress; keep under input when live.
