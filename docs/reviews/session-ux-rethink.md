# SESSION-UX implementer checklist (self-review, not the formal review)

Branch `feat/session-ux-rethink`. Scope: Phase 1 + Phase 2 of
`docs/plans/session-ux-rethink.md`, and Phase 3 **undo only** (no `--sandbox`, no temp copy, no
concurrent items). Checked against `docs/plans/session-ux-rethink-READY.md`. Test names are
from `src/cli/commands/session.test.ts` (S), `src/cli/shell/run.test.ts` (R),
`src/cli/shell/model.test.ts` (M), `src/session/master.progress.test.ts` (P),
`src/cli/shell/join-args.test.ts` (J), `src/cli/commands/session-delta.test.ts` (D).

## Behaviour

- [x] Agent runs with `cwd` = project root; no `worktree`/`clone`/`branch` (also no `checkout`,
      `switch`, `stash`, `reset`, `clean`) — the sandbox PATH has a logging `git` wrapper as
      the spy. S: "runs the agent with cwd = project root and never adds a worktree, clone or
      branch"; pty/herdr variants assert `cwd`/`start … <repo>`.
- [x] Two consecutive sessions, both `I-1`, both succeed. S: "two sessions on the same device
      and project both run their I-1".
- [x] No `<home>/session/worktrees`; `git branch --list 'skep/*'` empty with submit `none`.
      S: first test above.
- [x] Join with no AGENT.md and no `--role-dir`. S: "joins with no AGENT.md and no --role-dir,
      naming the agent and the folder".
- [x] Resolution order flag > `/agent` (device.toml) > `SKEP_AGENT_CLI` > AGENT.md > PATH with
      stub CLIs. S: "honours flag > /agent > …", "device.toml [agent] cli is the /agent
      setting …".
- [x] No agent ⇒ join fails with "no agent CLI found", never connects. S: "no agent anywhere:
      join fails …"; R: "a /join without any agent fails with one cause and one fix …".
- [x] Marker strings absent from `src/`; `--view dry` is failed-class and commits nothing.
      S: "the dry marker and its fake-success text are gone from src/", "--view dry runs
      nothing …".
- [~] Legacy `--agent pty|native|herdr`: **joined with a notice in Phase 1; Phase 2 removes the
      alias as the plan says**, so it is now refused with "`--agent pty is now --view pty`"
      before connecting. S: "legacy --agent pty is refused with its replacement …"; J, R.
      Phase 1 and 2 ship together, so no release carries the deprecation window — flag for
      the reviewer.
- [x] Changed files + diffstat; unchanged tree ⇒ `no changes`. S: first test, "reports no
      changes when the agent changed nothing"; D: line counts.
- [x] Pre-dirty tree not stashed/reset; only run-changed files listed; annotated. S: "a
      pre-dirty tree is left alone …"; D: git snapshot test.
- [x] Two items on one peer strictly sequential. S: "a second item waits for the first agent to
      exit".
- [x] Non-zero exit ⇒ master `FAILED` block with cause, fix and full text, > 600 chars.
      S: "a non-zero exit is a FAILED block …"; P: "never caps a FAILED block".

## UX

- [x] 400-char error at 80 columns wraps to several rows, whole text visible, hanging indent;
      info still truncates. M: "a 400-character error wraps …" (snapshot).
- [x] `/join` success line names the agent and "edits this folder directly". R: "/join names
      the agent …", SAME-CB shell test.
- [x] `/clean` prints "nothing left on disk"; runs no git (logging wrapper unchanged). R: same.

## Compatibility

- [x] `src/session/messages.ts` has no diff (`git diff 20cfc30 -- src/session/messages.ts`).
      `commit` travels as `none`/`local`; branch is the current branch or `HEAD`. S: "a new
      peer's result stays valid on the unchanged wire for any master"; P: old-peer summaries
      (no status line) still render in `itemBlock`. No recorded-frame version matrix.
- [x] MULTI-PROJ and SAME-CB tests pass; SAME-CB tests were updated (not skipped) because
      unborn/non-git folders now run the agent instead of failing a git check.
- [x] Legacy `skep/session/*` branch ⇒ clear message, nothing deleted. S: "submit on a legacy
      skep/session/* branch says so and deletes nothing".

## Process

- [x] ARCHITECTURE D27 amended, D31 added; PRD §7.3 note; tui-session-reliability cross-link.
- [x] CHANGELOG under `[Unreleased]`; no version bump; no publish.

## Phase 2 / 3 extras

- Submit on deltas: `commit` only the item's files (`--only`), `push` current branch, `pr`/`mr`
  build `skep/<item>-<slug>` via a private index (no checkout, working tree untouched). S:
  "submit modes on the item's delta" block.
- Roll-up: `intent-done` event and `/status` per-intent line. P, S.
- `/agent` persisted in `device.toml [agent] cli`. S, R.
- Undo: `skep session undo <item> [--force]`, `/undo`. Refuses on drift, on unkept content, on
  a second undo. S: "session undo" block; D.
- Not done: optional second-model digest (roll-up is plain concatenation).

## Risks for the formal review

1. New file `src/cli/commands/session-delta.ts` is outside the plan's MVP file list (kept
   `session.ts` from growing past ~3.5k lines; undo needs it anyway).
2. Delta attribution is content-hash based: a human editing the same folder during a run is
   attributed to the item. A file that was already dirty is committed with the human's edits
   too under `commit`/`push`/`pr` (the tree has one version of it).
3. Non-Git folders are walked fully (cap 20 000 files; content kept up to 64 MiB for undo and
   diffstat, beyond that hash-only and undo refuses those files).
4. Checks now read `.skep/checks.toml` from the working tree, which the agent can edit; the
   agent already runs arbitrary commands, so no new capability, but it is a trust change.
5. `itemBlock` parses the peer's summary layout (status line, `changed N files`) — a text
   convention, not a schema; old peers degrade to the plain summary.
6. Test hygiene: this box has real `codex`/`pi` in `/usr/bin`; all session/shell tests now run
   with a PATH of stubs + git only. Any future test that joins with the real PATH would launch
   a real agent.
