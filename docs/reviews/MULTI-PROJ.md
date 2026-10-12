# MULTI-PROJ review

Date: 2026-10-12.
Reviewed commit: `44eeaf4` on `fix/multi-project-same-machine`, against `main` at `bd431ab`.
Verdict: **PASS_WITH_NOTES**.

No blocking implementation finding was identified. The diagnosis and the deliberately small
error-guidance change satisfy the acceptance checklist by source inspection. Lint passes and
the merge check is clean. The required focused suite does not pass in this sandbox because
loopback listeners are denied; real-socket behavior and the complete green gate remain
unverified here.

## Scope and merge

From `<repo>`, `git log --oneline main..fix/multi-project-same-machine` lists only the reviewed
commit. The merge-base diff changes five files: the diagnosis, the Unreleased changelog entry,
the shared session command implementation, and the CLI/shell tests. It contains 456 insertions
and 17 deletions. No dependency, configuration, shared protocol, or home-resolution change is
included.

`git merge-tree --write-tree main fix/multi-project-same-machine` exits **0** with no conflicts.
Its resulting tree is `e610dd5b099f5ab941094f05593c88325a97819f`, which matches the task branch
tree. `git diff --check` against the merge base also passes. Neither branch was moved, and
only this review file was added to `<worktree>` during the review; no commit was made.

## Acceptance checklist

| Criterion | Result and evidence |
| --- | --- |
| Diagnosis explains shared state, port 7419, supported patterns, and workarounds | **Meets.** `docs/plans/multi-project-same-machine.md` covers home precedence, the single control pointer, external-master discovery, rejection before binding, the separate-home bind conflict, concurrent publication races, cleanup, exact repo-label routing, and peer worktree/transcript/branch/herdr collisions. It distinguishes one-master joins from independent masters and provides separate home/listen and peer join instructions. |
| `session_running` advises separate homes and listen endpoints | **Meets.** `src/cli/commands/session.ts:2034` explains one session per home and supplies both the shell launch followed by `/start` and the terminal CLI equivalent. Changing only the repo or listen option still preserves the existing live-master guard. |
| Bind `EADDRINUSE` becomes actionable `session_port_in_use` | **Meets.** `src/cli/commands/session.ts:1872` catches the session engine's `ListenAddressError` only when its Error cause has that code. The typed CLI error names the attempted endpoint and explains an unused listen port and a separate home. Both CLI start and shell `/start` use this flow. |
| Other bind failures remain unchanged | **Meets.** Errors outside that narrow predicate are rethrown unchanged. The `EACCES` regression at `src/cli/commands/session.test.ts:527` passes in this review. |
| No automatic home rename, version bump, or released changelog edit | **Meets.** Home resolution and shell/controller implementation are unchanged; package version remains `0.1.8`; the changelog diff adds only a short Fixed entry under Unreleased. |
| Required regression coverage | **Meets by inspection; socket execution blocked.** `src/cli/commands/session.test.ts:466` covers another repo/cwd with and without a different listen option and verifies exact pointer retention and no new master. Line 494 covers a real occupied listener after a home override, preserving the original pointer and leaving no second pointer. Line 543 starts two real masters with separate homes and verifies separate status identities/endpoints and independent cleanup. `src/cli/shell/run.test.ts:341` and line 741 cover shell advice and retention of the displayed external master. |
| D19 and public-repository hygiene | **Meets for the change.** Inspection and an added-line scan found no provider credentials, private-key material, personal email literals, machine-specific host paths, or operational host details. Address literals introduced by the change are loopback examples; documentation otherwise uses generic checkout labels and user-home placeholders. Session control tokens are generated at runtime or synthetic test fixtures, not provider credentials. |

The concurrent-master test intentionally substitutes ephemeral loopback ports at the API seam
while also checking the requested listener options. This exercises actual independent masters,
control-file selection, and cleanup without relying on reserved fixed ports; it does not claim
to add automatic port allocation to production.

## Validation

The requested command was run in `<worktree>` with the configured default timeouts:

```text
npx vitest run src/config/paths.test.ts src/cli/commands/session.test.ts src/cli/commands/session.control.test.ts src/cli/shell/run.test.ts && npm run lint
```

It completed with exit **1** after approximately 241 seconds. The focused counts were:

| File | Passed | Failed |
| --- | ---: | ---: |
| `src/config/paths.test.ts` | 5 | 0 |
| `src/cli/commands/session.test.ts` | 81 | 29 |
| `src/cli/commands/session.control.test.ts` | 7 | 12 |
| `src/cli/shell/run.test.ts` | 30 | 11 |
| **Total** | **123** | **52** |

Vitest reports **one file passed, three failed, and 30 unhandled errors**. The errors are denied
loopback `listen` operations with `EPERM`. Fixtures awaiting only a successful listen time out
after 20 seconds; real session starts raise `ListenAddressError` with the same cause. The new
concurrent-master case cannot publish a started master and therefore fails its readiness
assertion. These failures do not establish a change-specific regression, but they also do not
verify the listener-dependent additions.

The chained lint invocation was skipped after Vitest failed. A separate `npm run lint` exits
**0**: Biome checks 82 files without changes, and TypeScript checking passes.

A supplemental name-filtered run of the path tests, the preserved non-collision bind failure,
and the shell's simulated port-collision advice exits **0**: **three files passed; seven tests
passed; 149 skipped**. Both listener-independent new error-path tests pass. This is a partial
check, not a replacement for the focused gate.

## Remaining note

Run the exact focused command in an environment permitting loopback listeners and, once it
and lint pass, run the full `npm test` suite required by the implementation brief. This review
does not claim a green focused or full-suite gate. The earlier diagnostic document explicitly
records the same implementation-time validation limitation.

**Final verdict: PASS_WITH_NOTES.** The implementation has no identified blocker; the note is
the unresolved real-socket and full-suite validation gate.
