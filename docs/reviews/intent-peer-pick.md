# INTENT-PEER review

Date: 2026-10-12. Branch: `feat/intent-peer-pick`.
Reviewed implementation: `8de0406`, against `main` at `00d497f`.

Verdict: **PASS_WITH_NOTES after the fixes included with this report.**
The original commit required fixes for picker targeting, cancellation, rendering, and quoted
repo parsing. No unresolved blocking finding remains in the corrected branch.

## Findings and fixes

| ID | Severity | Finding in `8de0406` | Resolution |
| --- | --- | --- | --- |
| R1 | P1 | `Shell.sendIntent` discarded selected peers with unknown repos. If all selected repos were unknown, it submitted a bare intent, allowing an unselected peer on the master's repo to receive the work. Mixed selections silently lost the unknown peers. | Refuse the entire selection when any selected repo is unknown; send nothing and explain how to use explicit `--repo`. Tests cover unknown-only and mixed selections. |
| R2 | P1 | After awaiting the picker, `sendIntent` replaced its original route with the latest discovery. If master A was replaced by B during selection, the intent and A's chosen repo names could be sent to B. | Retain the original route and verify master identity, endpoint, and token before dispatch. A regression simulates replacement while the picker is open and proves neither master receives an intent. |
| R3 | P2 | `ShellModel.frame` kept only the last picker rows. With a long roster or short terminal, the active cursor could be invisible while Space still selected that hidden row. | Render a window containing the active row. Test a 30-peer roster at 10, 12, and 24 terminal rows, including first, middle, and last cursors. |
| R4 | P2 | `Shell.shutdown` resolved questions but left the picker promise pending, so a submitted intent and the command queue remained unresolved after quit or SIGINT shutdown. | Cancel the picker during shutdown and prevent opening one during shutdown/cleanup. Tests prove Ctrl-C, `/clean`, and quit resolve the submission without sending work; existing Esc coverage also passes. |
| R5 | P2 | `parseIntentArgs('--repo "my app" ...')` treated `"my` as the repo and left `app"` in the intent. Empty quoted repo values were also accepted, unlike the intended usage behavior. Repo labels containing spaces are already supported by `/start` and the session contract. | Support double-quoted repo values and escaped quotes/backslashes; reject empty values. Add spaced-label, equals-form, repetition, and empty-value regressions. |

The fixes stay in the task's shell files, colocated tests, and task documentation. The master
routing implementation did not need a production-code correction.

## Requested checks

| Focus | Result |
| --- | --- |
| Lone-candidate fallback | **PASS.** `SessionMaster.route` filters disconnected candidates, attempts normal repo matches first, and falls back only when no request matched, `!explicitRepos`, and exactly one connected capability candidate remains. No peer or multiple unmatched candidates still yields `no_match`. |
| Explicit repo tracking | **PASS.** `submitIntent` derives `explicitRepos` from validated `input.repos !== undefined`. Explicitly naming the master's repo does not enable fallback. Invalid empty repo arrays are rejected by the existing input schema. |
| Plan repo after fallback | **PASS.** `plan` supplies the actual routed candidates' repos to `buildPlan`, preserving the peer's repo for datalist collection, item assignment, claim, and result validation. Tests assert the peer repo rather than the master's. |
| `/intent --repo` | **PASS.** Both separate and equals forms, repeated flags, unique repo order, quoted labels, and missing values are covered. Own-master and external control-port submissions receive the parsed repos. Free text retains literal `--repo` text. |
| Picker UX and cancellation | **PASS with the discovery limitation below.** More than one peer opens the picker only without explicit repos; a lone peer skips it. Arrow movement, Space selection, Enter with no selection, unique repo dispatch, Esc, Ctrl-C, cleanup, shutdown, and cursor visibility are tested. |
| Wire compatibility | **PASS.** No changes to session messages, public session interfaces, codec/channel, core schemas, dependencies, or package version. `explicitRepos` is private master state and absent from status and wire frames. TUI repos use the pre-existing optional control `repos` field. A test asserts the exact existing v1 control frame, and the checkout smoke also uses a peer with progress opt-in disabled. |
| Tests | **PASS.** The original focused six-file suite passed 128 tests but missed the findings above. Seven newly added regression cases failed against the original shell implementation before the fixes. The expanded suite covers those failures and routing boundaries, duplicate repos/earliest join, external submission, and completed work in a different checkout. |

## Remaining notes

1. Peers describe their repo only in response to an intent, not at join. A fresh multi-peer
   session therefore initially displays `?` repos. Use `/intent --repo <name> <text>` for the
   first intent; subsequent selections can use the discovered repos. The corrected shell
   refuses unknown selections instead of dispatching to an unintended repo. Discovery before
   the first intent is a follow-up beyond this minimal fix.
2. Selection addresses repo names, not peer IDs. Selecting two peers on one repo produces one
   item; selecting only the later peer can still assign it to the earliest joined candidate on
   that repo, even if that earlier peer was not selected. This is explicitly permitted by the
   brief and documented in the task plan. Precise peer assignment needs a separate change.
3. The checkout smoke initializes two real Git directories with different basenames, runs a
   real loopback master/sub connection, and submits both bare and explicit TUI intents. An
   injected Node fake agent records its cwd in the peer checkout, both results reach `done`,
   and neither marker exists in the master checkout. This verifies completed session work;
   a live Codex/PI/vendor CLI smoke from the brief was not run.
4. The optional CLI peer picker was not implemented; CLI `--repo` remains supported.

## Validation

All commands completed successfully:

```text
npm ci
npx vitest run src/session/master.presence.test.ts src/cli/shell/run.test.ts \
  src/cli/shell/session-controller.test.ts src/cli/shell/model.test.ts \
  src/session/state.test.ts src/session/messages.test.ts \
  src/cli/commands/session.control.test.ts
# 7 files, 161 tests passed
npm run lint
npm test
# 32 files, 749 tests passed
npm run build
git diff --check
```

Protocol, public interface, core, and package files were also compared directly with `00d497f`
and are unchanged. No merge, push, version bump, or publication was performed.
