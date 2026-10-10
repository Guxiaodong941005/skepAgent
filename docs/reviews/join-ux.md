# join-ux review

Date: 2026-10-10. Branch: `feat/join-paste-auto`. Reviewed commit: `c530875`.

**Verdict: FAIL.** Three independently reproduced defects affect pasteability, advertised
address validation, and cancellation of manual item prompts. Lint and the merge check pass;
the test suites do not pass in this sandbox.

## Scope and branch checks

Reviewed the join-ux task brief, `docs/plans/join-paste-auto.md`, the relevant session code,
ARCHITECTURE D19/D27-D29, and all ten changed files. The branch contains one commit:
`c530875 feat(session): pasteable /join line and peer auto mode`.
The merge-base diff contains 535 insertions and 69 deletions.

`git merge-tree --write-tree main feat/join-paste-auto` exits 0 with no conflicts and produces
tree `89d0c39ccd79d6043e4d8ad0241830b20706aa91`. `git diff --check` also passes.
Implementation files and branch commits were not modified. This review is left uncommitted
at `<worktree>/docs/reviews/join-ux.md`.

## Findings requiring fixes

### B1 - P2: Valid repo names do not round-trip through the paste line

Evidence: `src/cli/commands/session.ts:438`, `src/cli/commands/session.ts:443`,
`src/cli/commands/session.ts:535`, and `src/cli/shell/flags.ts:17`.

The formatters interpolate `repo` without encoding or quoting. `RepoRefSchema` accepts spaces
and shell metacharacters, and the default repo name comes from the checkout directory basename.
The slash parser splits on whitespace and does not interpret quotes.

An inline check using the production formatter/parser reproduced these cases:

- Repo `my app`: the generated `/join --host <host:port> --code <code> --repo my app`
  fails with `app is neither a 12-digit join code nor host:port`.
- Repo `app --submit push`: parsing silently changes the repo to `app` and adds `submit: push`.
- Repo `app; false`: the CLI twin contains an unquoted semicolon, which a normal shell treats
  as a command separator.

Preserve supported repo values through slash formatting/parsing and quote each argument for
the CLI twin. Add round-trip tests for spaces, option-like text, and shell metacharacters;
quoting the slash output alone will not fix its current parser.

### B2 - P2: Advertise accepts wildcard and malformed host values

Evidence: `src/cli/commands/session.ts:377`, `src/cli/commands/session.ts:393`, and
`src/cli/commands/session.ts:1771`.

`parseHostPort` validates the port and some delimiters but accepts arbitrary nonempty host
text. `isWildcard` misses `*`. Unlike listen, advertise is never passed to a listener that
might reject the invalid value.

With an injected fake master, `startMasterFlow` successfully accepted an advertise host of
`*` and a host consisting solely of whitespace, each followed by a valid port. These values
were retained on the flow for join hints. The whitespace value also cannot survive slash
argument parsing. This violates the concrete-address/no-wildcards requirement.

Reject wildcard and malformed host text before starting the master, using shared validation
for listen/advertise. Add CLI and slash-start tests proving that invalid advertise values
never reach `SessionApi.startMaster`.

### B3 - P2: A queued manual prompt survives `/clean`

Evidence: `src/cli/commands/session.ts:1419`, `src/cli/commands/session.ts:1480`,
`src/cli/commands/session.ts:2211`, and `src/cli/shell/run.ts:812`.

Manual confirmations share the terminal queue, but their queued callbacks do not check the
worker's abort signal. Cleanup clears existing questions before the joined flow is invalidated.
Resolving the first question releases the next queued callback while its join is still current.

A socket-free reproduction through the production `Shell` and join flow:

1. Join with `--manual --submit none` using an injected session API.
2. Deliver two item callbacks concurrently. The first question is visible; the second waits
   in the terminal queue.
3. Submit `/clean` while the first question is pending.
4. After cleanup resolves, the controller reports `mode: none`, but `model.question` is
   `Run item I-2 (app): item 2? [Y/n]`.

The idle shell still asks about an ended session, and its next ordinary command is consumed
as that question's answer. A second `/clean` is required to clear it.

Make current and queued confirmations obey flow cancellation, and prevent checkout after an
aborted confirmation. Add a regression covering two concurrent items, cleanup during the first
question, an empty question queue afterwards, and successful dispatch of the next `/help`.

## Acceptance checklist

| Criterion | Result | Evidence / limit |
| --- | --- | --- |
| One pasteable slash join line with host, code and repo | PARTIAL | Shared helpers reach TUI/CLI start, rotation, no-peer and rejoin hints. Ordinary single-word repos work; B1 breaks other supported names. |
| Optional CLI twin | PARTIAL | Printed with the start/no-peer hints; B1 requires shell quoting. |
| Advertise is dial address; listen is bind address | PARTIAL | In-process hints use advertise with listen fallback. CLI help explains both. B2 leaves invalid inputs accepted; shell help needs N1. |
| Peer defaults to auto; manual opts out | PARTIAL | Auto is selected unless `manual === true`; only manual adds item confirmation. Mode is announced and present in machine output. B3 breaks manual cancellation. |
| Submit still asks under ask policy | IMPLEMENTED; runtime gate limited | Existing ask/chooseSubmit path is preserved, and slash join now accepts submit overrides. Listener-dependent integration tests cannot pass here. |
| D29: no agent approval bypass | PASS | Native argv and agent execution/blocked handling are unchanged; no bypass flags or automatic agent approval were added. |
| D19 and public-repo hygiene | PASS for reviewed diff | No credentials or operational addresses, hostnames, emails, or absolute machine paths were introduced in tracked content; address literals in changed tests are synthetic fixtures. |
| Tests and lint green | NOT SATISFIED | Lint passes; focused and full tests fail in this sandbox, as detailed below. |
| No version bump; changelog only Unreleased | PASS | Package version remains `0.1.7`; changelog additions are confined to `[Unreleased]`. No dependencies or configs changed. |

## Validation

Ran the requested command in `<worktree>`:

```sh
npx vitest run src/cli/shell src/cli/commands/session.control.test.ts src/cli/commands/session.test.ts && npm run lint
```

- Focused tests: **126 passed / 45 failed / 171 total**; **3 files passed / 3 failed**;
  **26 errors**; exit 1.
- The failing test command short-circuited `&&`; ran `npm run lint` separately:
  **PASS**, Biome checked **82 files**, and TypeScript checking exited 0.
- Full `npm test`: **507 passed / 68 failed / 575 total**; **25 files passed / 6 failed**;
  **26 errors**; exit 1.

Listener failures report `listen EPERM` on loopback; associated control/shell tests time out.
The full suite also has seven subprocess-output failures in unchanged `src/util/exec.test.ts`.
These match the environment limitations documented in earlier reviews. They do not establish
that all suite failures are branch regressions, but the green acceptance gate remains unverified.
B1-B3 were reproduced separately with production code, fake session adapters, temporary storage,
and no sockets; their findings do not depend on those suite failures.

## Additional notes

- **N1 - P3:** `src/cli/shell/run.ts:517` lists listen/advertise in `/help` without explaining
  bind versus dial. Add the same distinction already present in CLI help. Showing the submit
  override and explaining manual confirmation there would also help shell users.
- A master in another process does not publish advertise in status/session storage, so external
  hints fall back to listen. The implementation plan explicitly documents this limitation.
- `--manual --ui` is explicitly rejected and documented; device configuration is not extended.
- The commit subject omits the task ID required by AGENTS.md; the task brief's suggested subject
  also omitted it. This is a convention note, not a functional blocker.

Fix B1-B3, add their regression coverage, and rerun the focused/full suites where loopback
listeners and subprocess output work before treating the task as complete.

## Fix round 1

Date: 2026-10-10. Reviewed only `c530875..64d0772` and the relevant calling code.
The branch contains the expected fix commit `64d0772` on top of `c530875`.
The fix changes nine files, with 303 insertions and 28 deletions. Source was not modified,
and this review remains uncommitted at `<worktree>/docs/reviews/join-ux.md`.

### Finding status

| Finding | Status | Code and regression evidence |
| --- | --- | --- |
| B1: paste-line quoting | FIXED for pasteable repo names | `src/cli/shell/flags.ts:22` tokenizes quoted spans and escapes; `quoteSlashWord` at line 58 is used by the formatter at `src/cli/commands/session.ts:469`. The CLI twin uses POSIX quoting at line 475. `src/cli/shell/join-args.test.ts:72` covers spaces, option-like text, metacharacters, quotes, backslashes, Unicode and padding. `src/cli/commands/session.test.ts:380` reads the CLI twin back through a real POSIX shell. The shell integration at `src/cli/shell/run.test.ts:350` covers a spaced repo. These regressions pass. |
| B2: concrete advertise validation | PARTIALLY FIXED; blocker remains | The original star/whitespace cases are rejected before `startMaster`. Eight CLI cases at `src/cli/commands/session.test.ts:353`, shared listen validation at line 371, and slash-start cases at `src/cli/shell/run.test.ts:340` pass. The new character-class checks still accept malformed IPv6 and a scoped unspecified IPv6 address; see below. |
| B3: queued manual prompt after cleanup | FIXED | `src/cli/commands/session.ts:1468` checks cancellation before asking and after the answer. `src/cli/shell/run.ts:894` rejects questions during cleanup. The regression at `src/cli/shell/run.test.ts:499` delivers two concurrent items, cleans during the first prompt, awaits both skipped results, asserts no second question, and verifies that the next `/help` dispatches. It passes. |
| N1: shell help | FIXED | `src/cli/shell/run.ts:575` explains bind/dial, auto/manual and the submit override. An independent production-shell check verified all those lines after cleanup. |

Independent socket-free checks also confirmed B1's original spaced/option-like/metacharacter
cases and the exact B3 cleanup interleaving. Control-character repo labels are explicitly
omitted from the slash line with a checkout-based fallback note; that limitation is documented
and tested.

### Remaining B2 - P2: Character classes are not address validation

Evidence: `src/cli/commands/session.ts:396`, `src/cli/commands/session.ts:408`,
`src/cli/commands/session.ts:410`, and `src/cli/commands/session.ts:412`.

The IPv6 expression checks permitted characters rather than IPv6 structure. The wildcard
check runs on the complete host including any zone suffix. The name expression also permits
empty DNS labels. With an injected master API and a valid bind target, each of these advertise
values was accepted, reached `startMaster`, and was retained on the returned flow:

1. A bracketed host formed from a nonzero hexadecimal hextet, three consecutive colons, and
   another nonzero hextet, followed by a valid port. Node's `net.isIP` rejects this as invalid.
2. A bracketed unspecified IPv6 address with a percent sign and zone identifier appended,
   followed by a valid port. Node recognizes it as IPv6, and an independent IP parser confirms
   that adding the zone does not make the underlying address cease to be unspecified.
3. Two DNS labels separated by two consecutive dots, followed by a valid port.

Thus the original star/blank examples are fixed, but the required malformed-address and
no-wildcards rule remains incomplete. These reproductions use no sockets and are independent
of the sandbox's listener restrictions.

Validate IP structure with an IP parser, validate hostname labels, and check the underlying
IPv6 address for unspecified/wildcard semantics after separating any zone identifier. Add CLI
and slash-start regressions for these cases, asserting that the master API is never called.

### Fix validation

Ran the requested command in `<worktree>`:

```sh
npx vitest run src/cli/shell src/cli/commands/session.control.test.ts src/cli/commands/session.test.ts && npm run lint
```

- Focused tests: **152 passed / 45 failed / 197 total**; **3 files passed / 3 failed**;
  **26 errors**; exit 1. Failures report loopback `listen EPERM` and associated timeouts in
  this sandbox. No added fix regression failed.
- The failed test command short-circuited `&&`; separately ran `npm run lint`: **PASS**,
  Biome checked **82 files**, and TypeScript checking exited 0.
- Ran a targeted selection of the new regressions in the parser, shell and session test files:
  **26 passed / 135 skipped**, **3 files passed**; exit 0. This includes the POSIX-shell quoting
  test and the concurrent manual-cleanup regression.
- The orchestrator reports **197 passed plus lint** outside this sandbox. That supplied result
  is consistent with the local environment failures; it does not cover the remaining B2 cases.
- `git diff --check c530875 64d0772`: **PASS**.
- In `<repo>`, `git merge-tree --write-tree main feat/join-paste-auto`: **PASS**, exit 0,
  no conflicts; tree `52f3fc6fbd199fab13ab8eaf9675f81ddf09055b`.

The fix adds no dependencies, version bump, configuration changes, agent approval-bypass flags,
credentials, or operational machine identifiers. Changelog changes remain under `[Unreleased]`.
The remaining blocking finding concerns input validation, not the sandbox test failures.

**Fix verdict: FAIL.**

## Fix round 2

Date: 2026-10-10. Reviewed only `64d0772..08dbc54` and the validation call sites.
Commit `08dbc54` is on top of `64d0772`, as expected. This round changes five files,
with 91 insertions and 19 deletions. Source and branch commits were not modified;
this append remains uncommitted at `<worktree>/docs/reviews/join-ux.md`.

### Remaining B2 status: FIXED

`hostProblem` at `src/cli/commands/session.ts:421` now uses Node's `net.isIPv4` and
`net.isIPv6` for IP structure. It separates and validates an IPv6 zone identifier before
checking the underlying address against a `net.BlockList` of unspecified addresses.
This handles compressed, expanded and mapped representations without character-class
approximations. Hostnames are split into labels, each checked for length and permitted
characters; empty labels and leading/trailing hyphens are rejected. Total hostname length
is bounded. Underscores remain intentionally tolerated.

The shared validation runs for listen and advertise at
`src/cli/commands/session.ts:1841` and `src/cli/commands/session.ts:1850`, before the
master API call at line 1870.

| Prior remaining case | Regression evidence |
| --- | --- |
| Malformed IPv6 with three consecutive colons | Added to the advertise rejection matrix at `src/cli/commands/session.test.ts:363`; also covered for listen and slash start. |
| Zoned unspecified IPv6 | Added at `src/cli/commands/session.test.ts:364`, with expanded and mapped unspecified variants nearby; also covered for listen and slash start. |
| Empty DNS label | Added at `src/cli/commands/session.test.ts:368`, with leading/trailing empty-label and trailing-hyphen cases nearby; also covered for listen and slash start. |

The CLI advertise matrix asserts `fake.calls.master` has length zero at
`src/cli/commands/session.test.ts:380`; the listen matrix makes the same assertion at
line 393. The slash-start regression includes all three cases and asserts no master call
at `src/cli/shell/run.test.ts:352`. Positive tests at
`src/cli/commands/session.test.ts:396` preserve valid hostname, IPv4, IPv6 and zoned IPv6
advertise values.

An independent socket-free check repeated the exact three inputs from Fix round 1 through
`startMasterFlow`, for both listen and advertise. All six were rejected with the expected
typed usage error before `startMaster` was called. No files or sockets were used by that check.

### Validation and notes

- Requested focused command in `<worktree>`: **170 passed / 45 failed / 215 total**;
  **3 files passed / 3 failed**, **26 errors**, exit 1. Failures report loopback
  `listen EPERM` and associated timeouts in this sandbox, matching the earlier rounds.
  The added address-validation regressions pass.
- Because the test failure short-circuited `&&`, ran `npm run lint` separately:
  **PASS**, Biome checked **82 files**, and TypeScript checking exited 0.
- Targeted validation tests in the session and shell files: **28 passed / 113 skipped**,
  **2 files passed**, exit 0. This covers rejection before master startup, shared listen
  validation, slash-start rejection and valid-address acceptance.
- `git diff --check 64d0772 08dbc54`: **PASS**.
- In `<repo>`, `git merge-tree --write-tree main feat/join-paste-auto`: **PASS**, exit 0,
  no conflicts; tree `58093eb900596593baaf1dea7713e1811a27178e`.

No new functional blocker was found in this fix. The changes preserve the earlier B1/B3/N1
fixes and add no dependency, configuration, version, credential or agent-approval changes.
Changelog edits remain under `[Unreleased]`, and added address examples are synthetic fixtures.

The remaining note is validation: the orchestrator's outside-sandbox focused test and lint
run is still pending. This reviewer cannot establish a fully green listener-dependent suite
under the current sandbox restrictions.

**Fix verdict: PASS_WITH_NOTES.**
