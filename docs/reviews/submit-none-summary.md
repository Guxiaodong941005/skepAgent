# Review: default submit none and master result summaries

Date: 2026-10-10. Reviewer: Codex. Branch: `feat/submit-none-summary`.

**Verdict: PASS_WITH_NOTES.** No blocking implementation defect was found. The requested
behaviour is implemented and independent in-memory checks pass. Lint and the merge check pass;
the required test suites do not pass in this sandbox, so the green test gate remains unverified.

## Scope and branch checks

Read the review and implementation briefs, `docs/plans/submit-none-summary.md`, AGENTS.md,
the complete changed-file diff, relevant session/shell code and tests, and ARCHITECTURE
D19/D27/D29 and section 16 alongside the PRD security requirements. This task has its own brief
and plan rather than a named DEV-PLAN row.

From `<repo>`, the branch comparison against `main` contains one commit:

- `a686ad1 feat(session): default submit none and relay result summary to master`

The merge base is `0444a12`; the diff changes 10 files with 222 insertions and 25 deletions.
`git diff --check` passes. `git merge-tree --write-tree main feat/submit-none-summary` exits 0
without conflicts and produces tree `b5c4da73d48cfa1d4458c4ca9979e4ec9aa19896`.

No implementation files or branch commits were modified. This report is left uncommitted at
`<worktree>/docs/reviews/submit-none-summary.md`.

## Acceptance checklist

| Criterion | Result | Evidence and limits |
| --- | --- | --- |
| Missing file, missing submit/method, or invalid file defaults to none; warning names none | PASS | `src/cli/commands/session.ts:721` changes both Zod defaults and DEFAULT_POLICY. Parse failures warn with `falling back to none`. The policy unit test passes. |
| Host git still forces push | PASS | The existing normalization at `src/cli/commands/session.ts:755` remains; the policy unit test covers it. |
| Explicit ask/pr/mr/push/none and CLI overrides still work | PASS by inspection and available tests | The enum and override precedence at `src/cli/commands/session.ts:2267` are preserved. Explicit ask remains in loader and worker tests; actual listener-based join tests are blocked here. |
| No submit question for none | IMPLEMENTED; integration validation limited | Worker submission only asks for method ask; none returns a local outcome. The new end-to-end default-none test cannot bind its listener. Existing worker tests and the updated shell default-none joined-line test pass. |
| Active join help, joined/controlText and CHANGELOG no longer imply ask is the default | PASS | Help and usage explain device policy with none fallback; controlText reports the effective method. CHANGELOG updates are under Unreleased. Older plan example needs N1. |
| Accepted results reach master scrollback with a redacted, bounded summary | PASS | `src/session/master.ts:534` independently redacts before applyResult; the accepted event uses the stored summary at line 551. The helper keeps eight non-empty lines and 600 content characters, plus a two-character truncation marker. Shell logs `item I-N: ...` with event tone at `src/cli/shell/run.ts:659`. Four independent accepted-result cases pass over in-memory streams. |
| Progress remains out of scrollback | PASS | `src/cli/shell/run.ts:631` only redraws; the new shell test checks progress silence. In-memory protocol checks confirm progress events contain only peer identity. |
| Rejects remain short and error-style | PASS | Master emits item ID plus a fixed rejection reason, without the rejected summary. Shell uses error tone at `src/cli/shell/run.ts:663`. Independent rejected-result and shell event checks pass. |
| D19 redaction/public-repository hygiene and D29 approval rules | PASS for changes; existing fixture note | Added-line checks found no absolute host paths, email literals, non-loopback address literals, literal credentials, or approval-bypass flags. A deliberately unredacted token sent at the encryption boundary is redacted by the master before storage/events. Existing private-address fixtures are noted in N2. Native argv and blocked-agent tests pass. |
| Core DeviceSubmitSchema left alone or justified | PASS | `src/core/schemas/config.ts` is unchanged and retains pr. The plan and commit explain that join uses the separate loose loader. |
| Version unchanged; CHANGELOG Unreleased only | PASS | Package files, dependencies, core schemas and configs are unchanged; version remains 0.1.7. |
| Tests and lint green | PARTIAL | Lint passes. Focused/full tests fail under the restrictions described below; rerun the gates in a suitable environment. |

`startMasterFlow` still forwards the same event text to connected consumers. Non-TUI
`session start` does not currently subscribe to these events; leaving it unchanged follows
the brief's TUI requirement.

## Validation

Commands were run from `<worktree>`:

| Command/check | Result |
| --- | --- |
| `npx vitest run src/cli/commands/session.test.ts src/cli/shell/run.test.ts src/session/master.progress.test.ts src/session/state.test.ts` | 115 passed / 46 failed, 161 total; 1 test file passed / 3 failed; 14 unhandled errors. |
| `npm run lint` | PASS: Biome checked 82 files without fixes, and TypeScript no-emit completed successfully. |
| Related shell/session spot-check: run, join-args, session-controller, model, state and progress tests | 111 passed / 9 failed, 120 total; 5 files passed / 1 failed; 9 unhandled errors. Failures are listener-dependent shell cases. |
| Targeted shell accepted-result/rejected-result and default-auto joined-line tests | 2 passed / 36 skipped. |
| Targeted policy, native argv, summary sanitization/cap, live worker and scrollback-cap tests | 20 passed / 1 failed / 97 skipped. The extra matching default-none join integration case fails at listener creation. |
| Independent inline master/sub checks using production protocol code and in-memory duplex streams | 5 passed: multiline/master-side redaction, line cap, character cap, empty summary fallback, and rejected result without summary. |
| `npm test -- --reporter=dot` | 553 passed / 71 failed, 624 total; 25 files passed / 6 failed; 26 unhandled errors. |

The prescribed focused command was invoked with `&& npm run lint`; because Vitest failed,
lint was subsequently run separately and passed.

A standalone loopback-listener check fails with `EPERM`, independently of Skep. The focused
failures are listener binding failures or timeouts in helpers that await listener creation.
The full run also reproduces seven failures in unchanged `src/util/exec.test.ts` involving
missing subprocess output, previously recorded in the session-reliability review. These
results do not demonstrate a regression from this branch, but they do not satisfy the green
test gate either. No real agent CLI, external network, or two-device trial was used.

The independent protocol checks use the supported `attach`/`stream` hooks without a kernel
listener. A temporary in-process encryption hook injects an unredacted result to verify the
master's own redaction, rather than relying on the sub's redactor. Full stored summaries are
preserved while emitted summaries are capped; accepted results emit one item-result event,
and rejected results emit only the short reason. The hook is restored after the check.

## Non-blocking notes

1. **N1 - P3: Older plan retains an obsolete joined-line example.**
   `docs/plans/join-paste-auto.md:83` still shows `submit still asks unless ...`, despite the
   current controlText and new plan being correct. Update that example to `submit: none` and
   simplify the earlier default wording at line 71. This affects documentation, not runtime.
2. **N2 - Existing fixture hygiene.** Private-network address literals remain in pre-existing
   shell/join fixtures. The change introduces none, and the added plans/changelog contain no
   private host details. Replace those fixtures with documentation-range examples in a separate
   cleanup; no actual address or credential values are reproduced in this report.
3. **Validation follow-up.** Re-run the focused command and `npm run lint && npm test` where
   loopback listeners and subprocess output are available before treating the test gate as green.

