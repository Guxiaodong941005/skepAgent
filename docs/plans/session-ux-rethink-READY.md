# Session UX rethink: MVP acceptance checklist (READY)

The MVP slice is ready to merge when every box is true and `npm run lint && npm test` is green.
Each item names at least one test.

## Behaviour

- [ ] Item on a peer runs the agent with `cwd` = project root; **no** `git worktree add`,
      `git clone`, `git branch` is executed (spy on the git runner in the unit test).
- [ ] Two consecutive sessions on the same device and project, both with `I-1`, both succeed
      (regression for `already exists; submit or delete it first`).
- [ ] No directory is created under `<home>/session/worktrees`; `git branch --list 'skep/*'` is
      empty after a run with submit `none`.
- [ ] `/join --agent native` (or auto) works with **no** `AGENT.md` present and without
      `--role-dir`.
- [ ] Agent resolution order honoured: flag > `/agent` > `SKEP_AGENT_CLI` > AGENT.md (if present)
      > PATH auto-detect (fake PATH dir with a stub `claude`).
- [ ] No agent resolvable ⇒ `/join` fails with the "no agent CLI found" message, peer is not
      registered, master shows nothing dispatched. Never a `dry run` result.
- [ ] The strings `dry run: committed the session marker` and `.skep-session-item` no longer
      appear in `src/`; `--view dry` (if kept) reports a failed-class result, commits nothing.
- [ ] Legacy `--agent pty|native|herdr` still joins and prints the one-line deprecation notice.
- [ ] Result reports changed files + diffstat; unchanged tree reports `no changes`.
- [ ] Pre-dirty tree: agent run does not stash/reset; only files that changed during the run are
      listed; already-dirty-and-changed files are annotated.
- [ ] Two items queued on one peer run strictly sequentially.
- [ ] Failing agent (nonzero exit) ⇒ master shows `FAILED` block with cause and the full text,
      not clipped to 600 chars.

## UX

- [ ] A 400-character error pushed into the shell scrollback at 80 columns renders on several
      rows with the whole text visible (model snapshot test); info lines still truncate.
- [ ] `/join` success line names the chosen agent and says it edits the folder directly.
- [ ] `/clean` prints that nothing is left on disk; no git commands are run.

## Compatibility

- [ ] Session wire unchanged: `src/session/messages.ts` has no diff; old master ↔ new peer and new
      master ↔ old peer exchange items (integration test with recorded frames or version matrix).
- [ ] Per-project home isolation tests (MULTI-PROJ) and SAME-CB tests unchanged and passing.
- [ ] `skep session submit` on a legacy `skep/session/*` branch either works or prints a clear
      "legacy branch" message; no branch is deleted automatically.

## Process

- [ ] PRD/ARCHITECTURE lines that require AGENT.md or session branches amended.
- [ ] CHANGELOG entry under a new unreleased heading; **no version bump, no npm publish** until
      review is recorded in `docs/reviews/`.
