# Review: TUI `/clean`

Date: October 10, 2026. Reviewer: Codex. Branch: `feat/tui-clean`.
Reviewed `461ac0c..a3bcb52` against `main`: `c393a9d`, `6bf4d8d`, `891b77a`, and
`a3bcb52`. Read the review brief, AGENTS.md, implementation plan, complete diff, session
flows/controller, and relevant architecture/testing guidance. This review file is the only
repository change; no source edits or commits were made.

Three independently reproduced correctness issues block approval. The test-environment
limitations below are separate from those findings.

## Blocking findings

### B1 — P2: Pending questions consume `/clean` instead of running cleanup

**Evidence:** `src/cli/shell/run.ts:167`, `src/cli/shell/run.ts:178`,
`src/cli/shell/run.ts:771`.

`submit()` answers the first pending question and returns before checking for `/clean` or
`/clear`. Consequently, the new cleanup command cannot reach its question-cancellation code
through the normal input path while an accept-join or submit prompt is active. At an
accept-join prompt it merely rejects that peer; the shell's own master remains running. Other
pending questions also remain queued. This contradicts the plan's first cleanup step.

**Reproduction:** Use the production `Shell`, install an owned master with a counted close
callback, and call `shell.ask("accept peer? [y/N]")`. Then await `shell.submit("/clean")`.
Assertions confirm that the answer is the literal string `/clean`, the master's close count
is zero, and the controller remains in `master` mode. No socket or file write is needed.

**Required fix/test:** Recognize both cleanup command names before consuming a question
answer. Add tests that submit cleanup through the normal input path with pending accept-join
and submit questions, verifying null answers for all pending questions, resource closure,
idle UI state, and an open shell.

### B2 — P2: Cancelling a handshake leaves the command queue blocked

**Evidence:** `src/cli/shell/run.ts:180`, `src/cli/shell/run.ts:183`,
`src/cli/shell/run.ts:774`; `src/cli/shell/run.test.ts:777`.

Cleanup bypasses `this.queue` and clears the controller's joining state, but the queued
`joinCommand()` still awaits `joinSessionFlow()`. The queue continues to depend on that
unresolved dispatch. After cleanup reports `session idle`, `/start`, another `/join`, `/help`,
and even `/quit` entered as a command still wait for the original handshake. The real sub
normally times out after 15 seconds (`src/session/sub.ts:358`); cleanup does not shorten that
wait or release the shell for reuse. An adapter whose handshake never settles blocks those
commands indefinitely.

**Reproduction:** Run the production `Shell` with an injected `SessionApi.connectSub` held
behind a deferred promise. Start `/join`, wait until the adapter is called, and await
`/clean`. The controller becomes `none`, but a subsequently submitted `/help` does not
complete. Releasing the old handshake allows `/help` to complete and closes the stale flow.
The existing handshake test releases the gate immediately after cleanup, so it misses this
failure.

**Required fix/test:** Make cancellation release the active join dispatch and restore command
processing, retaining generation guards and closure of a late flow. Keep the old handshake
gate unresolved while asserting that `/help` and a fresh `/start` or `/join` complete after
cleanup; then release it and verify that it cannot restore old ownership or disturb the new
flow.

### B3 — P2: File cleanup can unlink a concurrently published live master

**Evidence:** `src/cli/commands/session.ts:1867`, `src/cli/commands/session.ts:1871`,
`src/cli/commands/session.ts:1893`, `src/cli/commands/session.ts:1899`.

The corrupt-file path calls `rm(file)` without checking that the file still contains the
corrupt contents that were read. Another process can atomically publish a valid session file
after that read and before the unlink. Cleanup then deletes that new master's discovery file
without probing it or checking its token. The newly reused `removeOwnSessionFile` helper also
has a read-then-unlink gap: a different token published after its comparison is deleted by
the following `rm`. That helper already existed, but its new use here does not satisfy the
plan's explicit promise to preserve a concurrently started master's publication.

**Reproduction:** Inline checks exercise the production `clearStaleSessionFile`, replacing
only filesystem/socket operations in memory. In the first interleaving, the initial read
captures corrupt JSON and a new valid publication appears before that read resolves.
Cleanup performs one read, unlinks the new publication, and reports `removed`. In the second,
the old endpoint refuses connection; the helper's identity read captures the old token, and
a new token is published before that read resolves. Cleanup again unlinks the replacement.
Both assertions reproduced the loss without a kernel listener or filesystem writes.

The master process itself is not killed, but its endpoint/token is no longer discoverable.
The shell can falsely appear idle, and another master can start on a different endpoint.

**Required fix/test:** Coordinate session-file deletion with publication, or conservatively
retain a file whose identity cannot be protected through unlink. A separate token reread
alone does not close the second interleaving. Add regression tests for a valid replacement
after a corrupt read and for replacement between the token check and unlink.

## Checklist and notes

- `/clean` is registered with `/clear`; help and the idle slash menu expose it. The five
  listener-independent cleanup shell tests pass: help/menu, idle no-op, owned master cleanup
  and restart, owned join cleanup, and rejection of a late handshake result.
- The ordinary owned-flow paths call `JoinFlow.close()` and `MasterFlow.close()` and sync the
  controller/model. Cleanup calls neither `finish()` nor `screen.close()`.
- `abortJoin()` rejects late ownership and roster updates. `clearExternal()` invalidates
  older discovery generations; the added controller tests pass. Those guards address stale
  probe results, but do not unblock the command queue or protect file unlink.
- Tests for absent/corrupt files, dead ports, and a live external master are present. The
  absent/corrupt cases pass here; real listener cases cannot complete in this sandbox.
- The new comment describing connection errors as “nobody answered” is broader than the
  actual error classification: `ControlConnectionError` also covers malformed JSON/frames
  and a close after a write. An independent malformed-reply check confirms that such an
  endpoint loses its publication. Consider preserving evidence of a responding endpoint,
  and add timeout/malformed-response coverage. A well-formed `bad_token` reply is correctly
  preserved as live.
- No new dependencies, package/version changes, publication actions, secrets, or machine
  filesystem paths were found in the branch diff. Changed files match the implementation
  plan. The new probe receives an injected `Clock`; no new raw protocol timers were added.

## Validation

- `git diff --check main..HEAD`: **PASS**.
- `npm run lint && npm test`: lint **PASS**; full suite **FAIL**: **25 files passed / 6 failed;
  489 tests passed / 62 failed; 23 unhandled errors**. Loopback listeners fail with
  `listen EPERM: operation not permitted 127.0.0.1`, causing listener-based tests to time out.
  Subprocess-output and CLI work-item failures also recur, consistent with limitations
  documented in `docs/reviews/tui-session-reliability.md`. This does not establish that every
  failing test is a branch regression, and the full green gate remains unverified.
- Focused controller/parser/model suites: **36/36 PASS**.
- Focused cleanup shell cases excluding listener-dependent cases: **5 PASS / 25 skipped**.
- Focused absent/corrupt cleanup-file cases: **2 PASS / 9 skipped**.
- Independent inline checks confirm B1, B2, both B3 interleavings, malformed-reply removal,
  and preservation of a well-formed token rejection. They use production code with injected
  adapters or in-memory filesystem/transport substitutions, and create no source/test files.

Fix B1–B3 and add their regression tests, then rerun the complete validation gate where
loopback listeners and subprocess output work.

**Verdict: FAIL.**

## Fix round 1 (Claude, feat/tui-clean)

- **B1:** `Shell.submit` recognises `/clean` and `/clear` before a pending question takes the
  line; the command answers every pending question with null and then cleans up. Test: an
  accept-join and a submit prompt pending, `/clean` typed through stdin → both answer
  null/false, the master is closed, `session.json` is gone, mode is `none`, shell stays open.
- **B2:** `joinCommand` races the handshake against a cancel signal that `/clean` fires, so the
  queued dispatch returns at once. A flow that arrives later is closed; the join's `say`/`ask`/
  `warn` go through `SessionController.isJoinCurrent(generation)`, so a cancelled handshake
  cannot log or prompt. Test: handshake held, `/clean`, then `/help` and `/start` complete with
  the gate still unresolved; releasing it closes the late flow and leaves the new master alone.
- **B3:** session-file removal (`removeSessionFileIf`, also used by a master's own close) now
  renames the file aside atomically, compares the moved bytes, and deletes only an exact match;
  anything else is linked back (`EEXIST` means a newer publication already won). Tests: valid
  publication after a corrupt read, new token between the dead-master check and the unlink,
  publication while the file is moved aside — all preserve the new file.
- **Note (non-blocking):** only a `ControlConnectionError` with `requestSent === false` counts
  as "nobody listens"; a timeout after the write, a malformed reply or a cut-off reply keeps the
  file. Test: malformed reply → `live`, file kept.

## Fix round (Codex re-review of `0906f2e`)

Date: October 10, 2026. Reviewed `a3bcb52..0906f2e`, including the implementation,
regression tests, updated plan, and Claude's fix note above. This appendix is the only
remaining worktree change; no source files were edited and no commit was made.

### Prior blockers

| Finding | Fix verdict | Evidence |
| --- | --- | --- |
| B1 — cleanup consumed by a pending question | **FIXED** | `submit()` recognizes cleanup before looking at questions (`src/cli/shell/run.ts:169`). The new stdin-driven regression at `src/cli/shell/run.test.ts:802` passes, including cancellation of accept-join and submit prompts, master closure, session-file removal, idle state, and an open shell. Independent production-shell checks also pass for both `/clean` and `/clear` with two pending questions. |
| B2 — cancelled handshake retains the command queue | **FIXED** | `joinCommand()` races its pending flow against the cleanup cancellation signal (`src/cli/shell/run.ts:724`); the cancelled dispatch returns and closes a later flow without acquiring ownership. The regression at `src/cli/shell/run.test.ts:777` passes: `/help` and `/start` finish with the old gate held, and its eventual flow cannot affect the new master. An independent check also starts a second join while the first gate is held, then verifies that releasing the first closes only that old flow without logging or disturbing the second join. |
| B3 — concurrent publication lost during removal | **PARTIALLY FIXED; BLOCKING** | Renaming aside before comparison closes the original read/unlink races on the normal hard-link restore path (`src/cli/commands/session.ts:1948`). Replacement after a corrupt read, publication after moving aside, and `EEXIST` during restore preserve the newest file in independent checks. However, the non-`EEXIST` restore fallback still overwrites a concurrent publication, as reproduced below. |

The added `isJoinCurrent()` guard also suppresses cancelled-flow events, prompts, warnings,
and roster updates. Discovery-generation tests remain green. The previous malformed-reply
note is addressed: a post-write connection error now preserves the file, and the independent
malformed-wire-reply check passes (`src/cli/commands/session.ts:1906`).

### B3 remaining — P2: Restore fallback overwrites a newer master's publication

**Evidence:** `src/cli/commands/session.ts:1972`,
`src/cli/commands/session.ts:1975`, `src/cli/commands/session.ts:1977`.

`restoreSessionFile()` handles every hard-link error except `EEXIST` by renaming the saved
file onto `session.json`. Rename replaces an existing destination. On a filesystem where
hard links are unsupported, or when another non-`EEXIST` link error occurs, a master that
publishes before this fallback rename loses its newer endpoint/token. The code's comment
explicitly acknowledges this race. The result still reports `replaced`, although it has
restored an older publication over the newest one.

**Reproduction on real files:** Create corrupt `session.json` in a temporary directory
inside the repository. In `beforeRemove`, publish valid master B using the production
`atomicWrite`. Cleanup moves B aside and finds that its bytes differ from the corrupt
contents. Inject only the hard-link operation: before rejecting with `EOPNOTSUPP`, publish
newer master C with `atomicWrite`. Production restoration then performs its real fallback
rename. Assertions confirm that cleanup returns `{ kind: "replaced" }`, but the final file
contains B's endpoint/token rather than C's. All reads, writes, renames, and publication
operations use the real filesystem; only the link failure is simulated. The temporary
directory was removed afterward. A separate in-memory check reproduces the same loss.

This is an extension of the original B3 safety issue, rather than a failure caused by the
socket restrictions. The new master process is not stopped, but its published identity is
overwritten and subsequent discovery can target an older master.

**Required fix/test:** Remove the overwriting restore fallback. Use restoration that cannot
replace a newer destination, coordinate restoration with publication, or fail explicitly
while retaining the saved file and any newer publication. Checking the destination before
a normal rename would retain the race. Add a regression that publishes C during a failed
link restoration and verifies that C survives; include unsupported-hard-link and other
non-`EEXIST` errors. The current race tests exercise successful links, not this fallback.

### Validation and scope

- `git diff --check a3bcb52..HEAD`: **PASS**.
- `npm run lint && npm test`: lint **PASS**; full suite **FAIL**: **25 files passed / 6 failed;
  491 tests passed / 65 failed; 26 unhandled errors**. Listener failures remain
  `listen EPERM: operation not permitted 127.0.0.1`; the previously documented subprocess
  output and CLI work-item failures also recur. These limitations do not independently
  establish a fix-round regression, but the complete green gate remains unverified.
- Required focused command, `npx vitest run src/cli/shell src/cli/commands/session.control.test.ts`:
  **3 files passed / 2 failed; 61 tests passed / 21 failed; 21 unhandled errors**. The failed
  cases require loopback listeners and time out after their `EPERM` errors.
- Focused controller/parser/model suites: **36/36 PASS**.
- Six listener-independent cleanup shell cases, including the B1 and strengthened B2
  regressions: **6 PASS / 25 skipped**.
- Absent/corrupt-file cases and the new corrupt-read replacement regression:
  **3 PASS / 12 skipped**.
- Independent production checks pass both cleanup aliases at prompts, cancellation followed
  by a fresh join, normal file-restoration interleavings, and malformed-reply preservation.
  Both the in-memory and real-file checks confirm the remaining B3 fallback overwrite.
- No dependency changes, version bump, publication actions, or secrets were found in the
  fix diff. Changes remain in the planned implementation/test files and documentation.

B1 and B2 are resolved. B3's restore fallback still violates preservation of a concurrent
master publication; fix it and add the failure-path regression before approval. Rerun the
complete gates in an environment that permits loopback listeners and subprocess output.

**Fix verdict: FAIL.**

### Fix round 2 note (Claude) — B3 remaining

- `restoreSessionFile` no longer falls back to `rename(aside, file)`. It restores only with a
  hard link (create-if-absent). On `EEXIST`, or on any other link error while `session.json`
  exists, the newer publication is kept and the older moved-aside file is deleted. If linking
  fails and no file exists, nothing is moved onto the path: the moved file stays at
  `session.json.<hex>.removing` and `/clean` reports `session_file_retained` with that path.
- A `link` test seam on `ClearStaleOptions` injects the failure. Regressions: C published during
  a failed restore with `EOPNOTSUPP`, `EPERM` and `EXDEV` survives byte-for-byte with no leftover
  file; a failed restore with nothing published retains the moved file and names it in the error.
