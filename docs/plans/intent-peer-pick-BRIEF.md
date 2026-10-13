# Intent peer pick (INTENT-PEER) — BRIEF

Status: implement on `feat/intent-peer-pick`. Do **not** bump version or publish. Do **not** merge.

## Blocking user bug (must fix first)

Master repo `futrobomower`, lone peer joined from `skepAgent`. Bare TUI `/intent 查看当前分支` fails with:

```text
no connected peer works on repo futrobomower (peer-1 …: repo skepAgent)
```

Also TUI `/intent --repo skepAgent …` currently **ignores** `--repo` (run.ts `sendIntent` passes raw text to `submitIntent` with no repos).

## Goals

1. **Lone peer auto-route.** When exactly one connected peer answered capability for this intent (`candidates.length === 1`) and repo matching produced no requests, still assign the work to that peer (item.repo = peer.repo). Bare `/intent <text>` and free-text intents must succeed even when `peer.repo !== master.repo`. Explicit `--repo` that matches nobody still `no_match`.

2. **TUI `/intent --repo X <text>`.** Parse `--repo` (one or more) out of the slash args before submit. Pass repos into `submitIntent(text, repos)`. Free text without `/intent` stays bare text (no flag parse). CLI `skep session intent --repo …` already works — keep it.

3. **Multi-peer picker (TUI).** After Enter on `/intent <text>` or free-text intent, if **more than one** connected peer is in the master roster and the user did **not** pass `--repo`:
   - Show a multi-select list: `peerId  device  repo` (repo `?` if unknown).
   - Keys: ↑/↓ move, Space toggle, Enter confirm (≥1 selected), Esc cancel.
   - Dispatch **one intent** with `repos = selected peers' repos` (unique). Prefer existing multi-repo → one plan item per repo. If two selected peers share one repo name, still one item (earliest join) — document; optional follow-up for peerId assignees.
   - Lone peer: **no picker**; auto-route (goal 1).

4. **CLI (nice-to-have).** If easy: `skep session intent --peer <id>…` or when TTY and multiple peers, prompt. TUI is priority; skip CLI peer picker if time-boxed.

## Wire

Prefer **no** protocol change. Routing fix lives in `SessionMaster.route` / `submitIntent` defaults + TUI arg parse. Optional additive `peerIds` on control intent is OK only if needed; do not break old clients.

## Do not

- Worktrees / AGENT.md gates
- Bump package version / publish / merge main
- Change join slim paste UX

## Files (stay near these + tests + docs)

- `src/session/master.ts` — lone-candidate fallback in `route`
- `src/session/state.ts` — only if buildPlan needs a peerId path
- `src/cli/shell/run.ts` — parse `/intent` flags; multi-select picker; pass repos
- `src/cli/shell/model.ts` / `input.ts` — picker overlay if needed
- `src/cli/shell/session-controller.ts` — expose peer `repo` on shell peers if picker needs it
- `src/cli/commands/session.ts` — CLI `--peer` only if easy
- Tests: master route, run.ts intent `--repo`, lone-peer no_match regression
- `CHANGELOG.md` `[Unreleased]`, `docs/plans/intent-peer-pick.md`, this BRIEF
- `README.md` one-liner on intent peer routing if helpful

## Acceptance (must prove live)

1. Two git dirs with **different** basenames on same machine. Master in A, join from B only (one peer). Bare intent (no `--repo`) completes work in B's cwd.
2. Same setup: `/intent --repo <B-basename> <text>` routes to B (not A's name).
3. Unit/integration tests for lone-peer fallback and TUI `--repo` parse.
4. Codex review PASS or PASS_WITH_NOTES after fixes.

## Live smoke sketch

```bash
# dir A = master, dir B = peer (different basename)
skep session start --yes --listen 127.0.0.1:PORT --device box-a
# from B: skep session join --code … --host 127.0.0.1:PORT --agent pi --submit none --view native
# master API or TUI: intent without --repo must create file in B
# master: intent with --repo B-name must also work
```
