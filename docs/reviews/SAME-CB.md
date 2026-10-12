# SAME-CB review

Date: 2026-10-12. Branch: `fix/same-machine-callback`.

**Verdict: FAIL — required test gate.** The root cause and fix are sound, all four new
regressions pass, and lint passes. However, the prescribed focused suite and the full suite
both exit 1. Representative failures reproduce on unchanged `main` under this sandbox;
no implementation defect attributable to this change was found. A passing test run in a
suitable environment is required before the task's all-tests-pass criterion can be accepted.

## Scope

Reviewed the implementation and review briefs, AGENTS.md, the complete changed-file diff,
the relevant CLI/shell/session code, the session-reliability plan's Bug 4, ARCHITECTURE
section 16/D19, and PRD section 11. SAME-CB is a bugfix brief, not a DEV-PLAN schedule ID.

`git log --oneline main..fix/same-machine-callback` contains one commit:

- `d3b0e1e fix(session): keep peers connected without Git HEAD (SAME-CB)`

The merge base and current `main` are `a1a4f9d`. The diff changes three files, with
216 insertions and 10 deletions:

- `src/cli/commands/session.ts`
- `src/cli/commands/session.test.ts`
- `src/cli/shell/run.test.ts`

The production change is confined to the join callbacks and their existing unknown-SHA
comment. Protocol schemas, session transport, core contracts, project-home isolation,
dependencies, configuration, package version, and release files are unchanged.
`git diff --check` passes.

The task worktree remains clean at `d3b0e1e`; no branch, implementation file, or commit was
changed during review. This uncommitted report is the only review edit in `<repo>`.
The pre-existing untracked unified-TUI brief was left untouched. No merge, publication,
version bump, or Git metadata workaround was performed.

## Root cause and fix

An explicit `--repo` supplies a routing label and bypasses automatic Git repository
discovery; it does not change the peer's working directory. Previously, `describe()` ran
`git rev-parse HEAD` there without recovery. An unborn/missing HEAD or non-Git directory
rejects that callback; an invalid returned SHA also fails `DescriptionSchema`. On receipt
of an intent, `src/session/sub.ts:176` catches either failure and calls `callbackFailed()`,
which emits the reported diagnostic and closes with `callback_error`. Likewise, an
uncaught `git ls-files` failure in the datalist callback closes the connection.

`src/cli/commands/session.ts:2427` now validates HEAD with `ShaSchema`, catches read or
validation failures, warns locally, and returns the existing forty-zero unknown SHA.
That sentinel satisfies the wire schema and the existing failed-work result convention.
At line 2442, a failed tracked-file listing warns and returns an empty datalist. Successful
Git reads and tracked-file enumeration retain their previous behavior.

This preserves the peer's connection without pretending an unusable checkout can execute
work. The unchanged materialization failure handler at `session.ts:1579` returns a typed
result with a failed Git check and failed submit outcome. The peer can answer another
intent afterward. Same-device names do not collide: authenticated connections receive
distinct peer IDs; the shell regression exercises `peer-2` while another peer is connected.

## Acceptance checklist

| Criterion | Result | Evidence |
| --- | --- | --- |
| Missing/unborn local HEAD does not kill describe | PASS | The unborn case in `src/cli/commands/session.test.ts:1358` has no HEAD commit, returns the unknown SHA, preserves its peer, and completes two intent/result exchanges without a session error. Read and SHA-validation failures are both caught. |
| Non-Git directory does not kill describe or datalist | PASS | The non-Git case in the same parameterized regression sends an empty datalist, reports failed Git work, stays connected, and answers a second intent. |
| Same machine, different directories work | PASS | The committed case routes the master's repository label from a differently named peer directory, collects its tracked files, and reports local work for two intents. All three cases use the same device name on master and peer. |
| Shell peer remains joined after the master's intent | PASS | `src/cli/shell/run.test.ts:625` runs the production join flow, shell view, master, and sub over in-memory duplex streams. Two peers share a device name; the non-Git `peer-2` stays joined, shows actionable warnings, and never displays callback failure or leave. |
| Join code remains single-use after leave | PASS | Handshake code is unchanged (`src/session/master.ts:403`). An independent in-memory production-protocol check joins, leaves, rejects the consumed code with `bad_code`, then accepts the current code. |
| No version bump or publish | PASS | Package/release files are absent from the diff; version remains 0.1.9. No publication command was run. |
| D19 and public-repository hygiene | PASS for changes | Added-line scan finds no absolute host paths, email literals, or credential assignments. New endpoint fixtures use loopback and a reserved example domain; device/project names are generic. No provider configuration or credentials are read or forwarded. Existing datalist/result redaction is unchanged. |
| Required focused tests and lint pass | FAIL for test gate | Focused tests exit 1 with 60 failures; separately executed lint exits 0. All four added regressions pass. See validation and F1 below. |
| Full tests pass | FAIL for test gate | `npm test` exits 1 with 79 failures. See validation and F1 below. |

The passing regressions use real temporary Git repositories and the production encrypted
session protocol with its supported stream hooks. They exercise callbacks, routing, work
results, and the shell without opening a kernel listener. No real agent CLI or Mac/LAN
trial was performed.

## Validation

Commands run from `<worktree>`:

| Command/check | Result |
| --- | --- |
| `npx vitest run src/session src/cli/commands/session.test.ts src/cli/shell && npm run lint` | Vitest exits 1: 255 passed / 60 failed, 315 total; 11 files passed / 4 failed; 20 unhandled errors. The chained lint does not run because Vitest fails. |
| Separate `npm run lint` | PASS, exit 0: Biome checks 82 files without fixes; TypeScript no-emit succeeds. |
| `npx vitest run src/cli/commands/session.test.ts src/cli/shell/run.test.ts -t 'same-device peer\|same device name and a non-git cwd' --reporter=verbose` | PASS: 4 passed / 161 filtered-out tests; 2 test files passed. |
| `npm test` | Exit 1: 574 passed / 79 failed, 653 total; 25 files passed / 6 failed; 32 unhandled errors. |
| Independent join/leave/reused-code/current-code check | PASS through production master/sub code and in-memory duplex streams. |

Baseline checks run from `<repo>` on unchanged `main`:

- `npx vitest run src/session/master.progress.test.ts -t 'opts both subs in' --reporter=verbose`
  fails its selected test with `ListenAddressError` caused by `listen EPERM` on loopback;
  11 tests are filtered out.
- `npx vitest run src/util/exec.test.ts -t 'gives the child exactly' --reporter=dot`
  fails its selected test because subprocess stdout is empty and JSON parsing fails;
  12 tests are filtered out.

No tests were changed, skipped by source edits, or deleted during review. The targeted
regression command's filtered tests also ran in the prescribed broader suites.

## Merge check

From `<repo>`, `git merge-tree --write-tree main fix/same-machine-callback` was attempted
and exits 128: `unable to create temporary file: Read-only file system`, followed by
`failure to merge`. The sandbox mounts Git metadata read-only, so this command cannot
complete its object-writing phase. This is not evidence of a merge conflict.

The read-only three-tree check,
`git merge-tree $(git merge-base main fix/same-machine-callback) main fix/same-machine-callback`,
exits 0 and marks all three changed paths merged without conflicts.
`git merge-base --is-ancestor main fix/same-machine-callback` also exits 0. The branch is
a direct descendant of current `main`, so a merge is a fast-forward; its existing tree is
`dea7e7afcf39a69d45d72c7633305826a6dba6d8`. The requested write-tree command still needs
an unrestricted rerun; no merge or object-directory workaround was used here.

## Findings

**F1 — Required test gate is not green.** The focused suite has 60 failures across
`session.test.ts` (31), `shell/run.test.ts` (12), `master.progress.test.ts` (11), and
`master.presence.test.ts` (6). All involve listener errors or related helper timeouts.
The full suite adds 12 listener-dependent failures in unchanged `session.control.test.ts`
and seven subprocess-output failures in unchanged `util/exec.test.ts`, totaling 79.
Representative listener and subprocess failures reproduce on `main`; these results do
not establish a SAME-CB regression. Nevertheless, the explicitly required passing test
gate was not obtained, which is the sole reason for FAIL. Re-run the prescribed focused
command and `npm run lint && npm test` where local listeners and subprocess output work,
then reassess the verdict. No source fix is requested on the evidence of these failures.

**N1 — Merge-command environment limitation.** The branch ancestry and read-only check
show no conflicts, but the required write-tree command could not complete against
read-only metadata. Re-run that command in the normal review environment.

No additional implementation, scope, credential-handling, or join-code defect was found.

## Fix round / re-verification

Date: 2026-10-12. Re-reviewed the unchanged `d3b0e1e` implementation using the
outside-sandbox verification supplied by the user from the orchestrator. Local read-only
checks confirm that `fix/same-machine-callback` and the clean task worktree still point to
that commit; `main` remains `a1a4f9d`. No code changes were needed.

The orchestrator ran the following commands outside the Codex sandbox in `<worktree>`:

| Command | Reported result |
| --- | --- |
| `npx vitest run src/session src/cli/commands/session.test.ts src/cli/shell && npm run lint` | PASS: 315 tests passed; lint exit 0. This verification was used for the commit. |
| `npm test` | PASS: 31 test files, 653 tests passed, 0 failed; exit 0. |
| `npm run lint` | PASS: exit 0. |
| `git merge-tree --write-tree main fix/same-machine-callback` | PASS: exit 0, clean. |

**F1 is resolved:** the required focused and full test gates pass for the same reviewed
commit. The earlier listener/timeouts and subprocess-output failures were specific to
the sandbox and reproduced on `main`; they were not caused by SAME-CB.
**N1 is resolved:** the required write-tree merge check completes cleanly outside the
sandbox. These supplied results supersede the initial validation-based FAIL.

The prior root-cause, regression, single-use join-code, scope, version, and D19 findings
remain valid. No implementation defect or unresolved review note remains. This round
only appends to the review report; no worktree or branch modification, commit, merge,
version bump, or publication was performed.

**Fix verdict: PASS.**
