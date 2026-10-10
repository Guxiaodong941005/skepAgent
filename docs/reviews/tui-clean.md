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
