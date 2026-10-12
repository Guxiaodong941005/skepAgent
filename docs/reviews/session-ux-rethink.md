# Review: SESSION-UX in-place execution, aggregation, submit and undo

Date: 2026-10-12. Reviewer: Codex. Branch: `feat/session-ux-rethink`.
Reviewed HEAD: `ab84562`.

**Verdict: FAIL.** The main execution change is implemented, the wire is unchanged, and
lint, all 693 tests and the merge check pass. Eight blocking findings remain: undo can delete
an unrelated symlink target or act on a previous session's item; deferred submit includes later
edits; a blocked agent releases the item queue; already-committed deltas cannot be pushed;
aggregation mislabels failed/pending outcomes; and paging and `/status` still hide result text.
The green tests do not cover these cases.

## Scope and branch checks

Read AGENTS.md, the plan, BRIEF and READY, the implementer checklist formerly in this file,
`docs/reviews/submit-none-summary.md`, the full branch diff, relevant session/shell implementation
and tests, ARCHITECTURE D19/D27-D31 and section 16, and the PRD session amendment and security
requirements. This task has a dedicated plan rather than a SESSION-UX DEV-PLAN row.

Scope is Phase 1 and Phase 2, plus Phase 3 **undo only**. Optional model digest is not required.
No sandbox implementation, temp-copy execution mode or concurrent-item feature was introduced.
The implementer checklist is folded into the acceptance table and notes below.

This clone has no local `main` ref. The comparison used `origin/main...HEAD`, the equivalent
available baseline: `origin/main` and the merge base are both `8941a041c4afaa3de89269ec4a9cb355a30507d7`.
The six branch commits are:

- `20cfc30` — add the SESSION-UX plan.
- `f2e0431` — measure and record in-place deltas.
- `f4071b3` — run in the project folder; resolve agent or fail.
- `14e5e2c` — persist `/agent`; remove legacy aliases.
- `8a76732` — CHANGELOG and PRD/ARCHITECTURE amendments.
- `ab84562` — implementer checklist.

The diff changes 23 files, with 3532 insertions and 777 deletions. `git diff --check
origin/main...HEAD` passes. `git merge-tree --write-tree origin/main HEAD` exits 0 without
conflicts and produces `f47315ad1029ea9965fa7188eea2f67f2aed56d4`, also HEAD's tree.
The supplied main tip is an ancestor of this branch, so it is mechanically mergeable.

No implementation files, index entries or branch commits were changed by this review. Only
`docs/reviews/session-ux-rethink.md` is intentionally changed and is left uncommitted. The
pre-existing untracked `node_modules` entry is retained. No push, publish or version bump was
performed. Probe directories were created inside the clone and removed.

## Blocking findings

1. **R1 — P1: Forced undo follows a new symlink and deletes its unrelated target.**
   `src/cli/commands/session-delta.ts:472` passes the complete file path through `safeJoin`.
   That helper returns the canonical target of an existing symlink, so subsequent hashing,
   unlinking and writing operate on the target rather than the recorded directory entry.
   Reproduction: start with tracked `valuable.txt`, have the item create
   `new-link.txt -> valuable.txt`, then undo. Normal undo incorrectly reports drift; following
   its suggested `--force` removes `valuable.txt`, leaves `new-link.txt` dangling, and reports
   that it removed `new-link.txt`. The deleted file was never in the delta. The independent
   production-helper probe confirmed all three effects.

   Resolve and validate parent directories without dereferencing the leaf being restored or
   removed. Preserve file type and symlink target in the record, or explicitly refuse unsupported
   leaf types before any mutation. Add regressions for new and modified symlinks, including a
   target that is another project file; force must remain limited to recorded paths.

2. **R2 — P1: A later session's unchanged item retains the previous session's undo/submit record.**
   `src/cli/commands/session.ts:2084` writes a record only when `delta.files.length > 0`.
   Records are keyed solely by item ID (`session-delta.ts:335`), and IDs restart each session.
   Reproduction: session A's `I-1` creates `first-item.txt`; session B's `I-1` changes nothing.
   B correctly reports `no changes`, but `/undo I-1` succeeds against A's record and deletes
   A's file. The probe observed the old record title and the deletion. Deferred submit can
   likewise pick up the old item. A dry, declined or early-failed replacement can also leave
   that record accessible.

   Bind records to the active session/run and make an empty or unexecuted replacement incapable
   of selecting an older item. Preserve old history separately if desired. Test two sessions
   with the same ID where the second changes nothing, is declined, or fails before execution;
   undo and submit must identify that run or refuse without touching the earlier changes.

3. **R3 — P1: Deferred submit commits and can publish edits made after the recorded item.**
   `src/cli/commands/session.ts:3306` reduces the record to paths and passes them to
   `submitDelta`. Neither `commitDelta` at line 1648 nor `branchFromDelta` at line 1695 checks
   the recorded after hashes; both read the current working files. Reproduction: `I-1` changes
   `notes.txt` to `item one`, then the human changes it to `later human edit`.
   `skep session submit I-1 --method commit` exits 0 and commits `later human edit` under I-1's
   title. The actual CLI probe confirmed this. `push`, `pr` and `mr` use the same current-file
   selection and can publish that later content. Two sequential items touching one file have
   the same attribution problem when the earlier item is submitted later.

   Before staging or creating refs, validate the entire selected delta against its recorded
   after state, and refuse drift with an actionable message, or materialize the recorded after
   content through the private index. This differs from the documented inclusion of edits that
   were already present before the agent ran. Test later edits and a second item touching the
   same file for commit/push and PR/MR, with no index/ref mutation on refusal.

4. **R4 — P2: A blocked herdr agent releases the queue while it can still edit the shared folder.**
   `src/cli/commands/session.ts:1389` intentionally leaves the pane open. The blocked path at
   line 2113 returns a pending result, which settles `workItem` and releases `serialQueue`.
   A queued second item therefore starts while the first agent is waiting for human approval.
   Once the human answers in that pane, both agents can edit the same folder and the second
   item's delta can include the first item's changes. The fake-backend probe observed the
   second start while the first handle was still blocked; no close had occurred.

   Retain peer execution ownership until the blocked run finishes or is explicitly cancelled,
   or refuse/defer further items while it remains active. Continue to require human approval;
   no automatic input is needed. Extend the sequential-items regression to a blocked first
   agent that resumes and writes before exiting.

5. **R5 — P2: An agent's own commit prevents the requested push.**
   `src/cli/commands/session.ts:1648` stages every stageable delta path and unconditionally
   invokes `git commit --only`. If the agent committed those changes, `computeDelta` correctly
   detects them via the moved HEAD, but the commit command exits 1 with `nothing to commit`.
   `submitDelta` catches that as failure and never reaches `pushBranch`. The probe ran an agent
   that committed `notes.txt` with submit `push`; the result was failed and the local bare
   origin still pointed to the pre-agent commit. The documented `null` return for nothing left
   to commit is reached only when there are no stageable paths, not when tracked paths are clean.

   Detect whether the selected files have anything left to commit. A no-op commit must allow
   push of the current branch and an honest local commit outcome. Cover an agent-created commit
   and the normal `none -> session submit commit -> session submit push` sequence.

6. **R6 — P2: Roll-up calls failed submits and blocked agents done.**
   `src/session/master.ts:77` checks only failed item state and failing checks; it ignores the
   submit outcome. `intentRollup` at line 120 treats every accepted done-state item as finished,
   and `intentFinished` at line 868 consequently emits final completion for a pending agent.
   `workItem` also sets the summary word to `done` after a failed submit (`session.ts:2217`).
   A failed push with skipped/passing checks produces `1 done · 0 failed`; a blocked result
   with `submit.state = pending` produces the same success count. Both production roll-up
   probes confirmed this, including R5's failed push. Failed submit details use the success
   event tone and success summary cap, so long errors are clipped as well.

   Distinguish completed execution, failed submission, pending/blocked execution and declined
   work in aggregation. Pending work must not announce final intent success; failed submission
   needs a readable cause/fix and appropriate failure rendering. Add event and `/status` tests
   for failed push/host creation and blocked pending results, including a multi-peer intent.

7. **R7 — P2: Wrapped errors cannot be paged back to their beginning.**
   `src/cli/shell/model.ts:150` expands one scrollback entry into several rendered rows, but
   `src/cli/shell/run.ts:248` still caps PgUp at the number of logical entries. A single long
   error may occupy dozens of rows while maximum scroll remains one. The production Shell
   probe appended 500 numbered words as one error, pressed PgUp repeatedly, and could never
   display the first word. The 399-character/80x24 snapshot passes because its entire error
   fits the viewport; it does not test scrolling or a shorter terminal.

   Calculate scrolling limits and append anchoring using rendered rows at the current width.
   Test a wrapped error longer than the body viewport, repeated PgUp/PgDn, and resizing; every
   word must be reachable without duplicating or dropping text.

8. **R8 — P2: `/status` truncates the full results it promises to show.**
   `src/cli/shell/run.ts:476` returns status as an ok message, and dispatch at line 340 logs it
   with the default info tone. `ShellModel` truncates that tone horizontally, including the
   cause and fix of failed items. The production `/status` probe retained the last word of a
   400-character cause in scrollback but never rendered it at 80 columns; its tone was info.
   In addition, `renderSessionStatus` at `session.ts:3608` uses `itemBlock`, whose success path
   applies the eight-line/600-character event cap. Thus even non-TUI status loses longer success
   summaries. The event cap is permitted by plan section 3.4; `/status` specifically promises
   the full last result in section 2.1.

   Preserve the complete stored summary for status and render result blocks with wrapping,
   including failures retrieved through an external master. Keep ordinary info-line truncation
   and the success event cap separate. Test both long failed causes and success summaries over
   600 characters through the actual shell command and terminal frame.

## Acceptance checklist

| Criterion | Result | Evidence and limits |
| --- | --- | --- |
| Agent cwd is project root; no worktree/clone/session branch on the default path | PASS | `projectRoot`, `joinSessionFlow` and the logged-git integration test cover in-place edits. Default none leaves HEAD/index alone; tests prohibit worktree/clone/branch/checkout/switch/stash/reset/clean calls. |
| Two sessions on the same project, both I-1, execute successfully | PASS for execution; FAIL for retained records | The consecutive-session test passes. R2 exposes the no-change replacement not covered by that test. |
| No session/worktrees directory or skep/* branch with none | PASS | The first in-place integration test checks both. Branch creation is confined to opted-in PR/MR submission. |
| Join without AGENT.md or role-dir | PASS with migration note | Auto or an explicit CLI works. Literal `--agent native` is rejected under the Phase 2 alias removal; use `--view native`. See N1. |
| Agent precedence: flag, /agent/device.toml, environment, optional AGENT.md, PATH | PASS | Resolution and persistence tests use installed stubs; the chosen CLI must be executable before connecting. Broken optional policy warns and falls through. |
| No resolvable agent fails before registration or dispatch | PASS | Session and shell tests assert the actionable message and zero connectSub calls. |
| No marker fake success; explicit dry reports failed-class and commits nothing | PASS | Source-string regression and dry integration test pass. Default view is native. |
| Legacy --agent pty/native/herdr joins with notice | SUPERSEDED, not satisfied literally | Phase 2 explicitly removes aliases; this branch rejects them with a replacement message before connecting. READY still describes the Phase 1 window. N1. |
| Changed files/diffstat; unchanged tree says no changes | PASS for covered files | Git/non-Git delta tests cover additions, edits, deletions and moved HEAD. Binary/unkept content has no line count; counts use a line multiset rather than Git's ordered diff. |
| Pre-dirty tree preserved; only run-changed files listed and annotated | PASS for execution | Dirty-tree tests preserve untouched human edits and untracked files without stash/reset. Pre-dirty changed files retain the documented whole-file submit limitation. R3 concerns later edits. |
| Items run strictly sequentially | PARTIAL / FAIL | The normal sequential-items test passes; pending herdr execution is not fenced by the queue (R4). |
| Nonzero agent exit produces FAILED, cause/fix and text beyond 600 characters | PASS at protocol/event boundary; PARTIAL in UI | The failing-agent and uncapped-master tests pass. Paging and status can still hide that text (R7/R8). |
| 400-character error at 80 columns wraps; info keeps truncation | PASS for the supplied viewport | Model snapshot covers 399 characters at 80x24. Long-error paging fails (R7); warn shares the wrapping path but has no corresponding snapshot. |
| Joined line names agent and direct folder editing | PASS | Session and shell integration tests cover the chosen CLI, source and working folder. |
| Clean ends connection state, reports no worktree/branch leftovers, runs no git | PASS | Shell copy and unchanged logging-git checks pass; user edits remain in the folder. |
| messages.ts unchanged; old/new peers exchange items in both directions | PASS | No diff to messages.ts. Independent old-master/new-peer and new-master/old-peer in-memory runs completed handshake, dispatch and accepted results with preserved summaries. N2. |
| Per-project isolation and SAME-CB retained | PASS with test-update note | Full suite is green. SAME-CB cases were adapted to expect successful in-place execution for unborn/non-Git folders, not skipped; their literal unchanged-test condition is not met. |
| Legacy session branch submit gives clear message without deletion | PASS | Legacy-branch regression checks the message, branch survival and absence of a push. |
| PRD/ARCHITECTURE session requirements amended | PASS | PRD section 7.3 explicitly exempts session mode; D27 amended, D31 added, reliability plan cross-linked. |
| Unreleased CHANGELOG; no version bump or dependency/config change | PASS | package.json, lockfile, core contracts and configs have no diff; version remains 0.1.10. |
| Phase 2 per-intent roll-up and final completion | PARTIAL / FAIL | Ordinary completion works and emits once. Failure/pending classification needs R6. |
| Phase 2 commit/push/pr/mr and deferred submit on recorded deltas | PARTIAL / FAIL | Basic commit/push/PR and deferred submit tests pass; R3/R5 cover incorrect content selection and already-committed deltas. MR uses the shared implementation but lacks a dedicated success test. |
| Phase 2 /agent persistence | PASS | Stored CLI survives the next join; tests verify other device.toml content and submit policy remain readable. |
| Phase 3 undo only | FAIL | Ordinary restore, drift refusal, force, repeat refusal and unavailable-content tests pass. R1/R2 invalidate safe undo. No sandbox was added. |
| Hygiene and purity | PASS with notes | No added literal credentials or concrete host filesystem paths found. Peer summaries and master storage remain redacted; transcripts/blobs are local private files. No new Date.now/performance.now/Math.random/setTimeout in reviewed production code; timing uses Clock, core unchanged. N3-N5. |
| Mergeability and required validation | PASS | Conflict-free merge tree, clean diff check, lint and 32 files / 693 tests green. These gates do not resolve the findings. |

## Validation

The user supplied independent worktree validation: `npm run lint` PASS and `npm test`
PASS, 32 files / 693 tests. This review reproduced both results in the clone.

| Command/check | Result |
| --- | --- |
| `npm run lint && npm test` | PASS: Biome checked 84 files without fixes, TypeScript no-emit passed; 32 test files and all 693 tests passed. Vitest duration 10.05 s. |
| `git diff --check origin/main...HEAD` | PASS. |
| `git merge-tree --write-tree origin/main HEAD` | PASS, no conflicts; output tree equals HEAD's tree. |
| Wire, core, package/lockfile comparison | No changes to src/session/messages.ts, src/core, package.json or package-lock.json. |
| Cross-version protocol probes | PASS in both directions against source from origin/main: handshake, item dispatch and accepted result, preserving old/new summary layouts and none/local wire shape. |
| Undo probes | R1/R2 reproduced: force deletes the symlink target; a later no-change I-1 undoes the previous run. |
| Submit probes | R3/R5 reproduced through the actual deferred-submit CLI and production worker: later content committed; agent-created commit prevents push to a local bare origin. |
| Blocked-queue and roll-up probes | R4/R6 reproduced: second agent starts with first still blocked; pending/failed-submit results count as done. |
| Production Shell/frame probes | R7/R8 reproduced: repeated PgUp cannot reach the error start; /status renders failed cause as truncated info. |
| Added-line hygiene and production timing scan | No concrete host filesystem paths, literal credentials, approval-bypass flags, unsafe shell execution or forbidden protocol timing calls found in added production code. N3 covers example-address hygiene. |

Probes used production modules, fake agent backends, temporary repositories and a local bare
origin. The compatibility probe loaded baseline protocol source into a temporary directory
inside the clone and paired it with current source over in-memory duplex streams. No real
agent CLI, provider connection, external network or two-device trial was used. No regression
tests were added because this review was authorized to change only this report.

## Non-blocking notes and implementer-checklist mapping

1. **N1 — Migration contract needs one consistent statement.** The implementer explicitly
   disclosed that Phase 1 and Phase 2 ship together, so no release carries the legacy-view
   deprecation window. Phase 2 authorizes alias removal, and CHANGELOG documents it, so this
   is not an additional blocker. Update READY/BRIEF examples to CLI names plus `--view`; do not
   claim the literal legacy-joins box passed.
2. **N2 — Compatibility coverage is currently a review probe.** The branch's schema and old
   summary rendering tests are useful but are not a two-version exchange test. The independent
   matrix here closes the immediate validation gap; retain a recorded-frame or version-matrix
   regression in the repository. Likewise retain the SAME-CB assertion changes as an intentional
   behavioral update rather than describing those tests as untouched.
3. **N3 — Public example hygiene.** Some new plan and test lines reuse private-network address
   examples. No real credential or identifiable host filesystem path was found. Prefer
   documentation-range addresses for new examples; no address values are reproduced here.
4. **N4 — Acknowledged delta limits.** The implementer disclosed content-hash attribution of
   simultaneous human edits and whole-file inclusion of pre-existing edits on changed files.
   Those are explicit plan trade-offs. Non-Git walks cap at 20,000 files and keep content within
   a 64 MiB budget; symlink content is not kept. Counts are approximate for moved lines. Ordinary
   unkept-content refusal has a test; these limitations do not excuse R1's deletion or R3's
   failure to detect changes after the recorded run.
5. **N5 — Scope and local state.** Extracting session-delta.ts is outside the MVP file list but
   is directly relevant to the authorized Phase 2/undo scope and adds no dependency or core
   contract change. Checks run from the project folder and can be edited by the agent, as the
   implementer disclosed; they should not be described as independent trusted verification.
   Transcript and delta content remain local, with private modes. Existing stub-only session
   and shell PATH setup avoids launching this host's real agent CLIs.
6. **Checklist disposition.** The implementer's positive mappings for agent resolution, default
   in-place execution, dry failure, normal delta reporting, legacy branches, persistence,
   documentation and green validation are confirmed. Its sequencing, aggregation, deferred
   submit, undo and full-error claims require the regressions identified in R1-R8. The optional
   second-model digest remains unimplemented by choice and is not a requirement for this review.

The branch is ready for a fix round, not merge approval. Re-review the corrected findings and
rerun the required gates before changing this verdict.
