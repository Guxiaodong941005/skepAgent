# JOIN-SLIM review

Verdict: **PASS_WITH_NOTES**

Reviewed on 2026-10-12 in `/tmp/skep-join-slim-review`, branch `feat/join-slim`.
The reviewed feature tip is `7f9f91d18843728b79b59884a00b4a3813e5579a`; the baseline is
`main` at `d1e0c7dc0da5f3432c076be3a145a5b03079c597` (v0.1.11). Scope comprises
`b33b56a`, `175ad23`, and `7f9f91d`. The plan and brief were read before inspecting the diff.
Session constraints were checked against PRD §7.3 and ARCHITECTURE D31.

The implementation meets the product intent: generated join commands carry only code and host,
repo and device keep their existing local defaults, and legacy overrides remain accepted.
There are no source changes required before merge.

## Blockers

None found.

## Non-blocking notes

**N1 (low) — Correct the brief's description of repo metadata on the wire.**
`docs/plans/join-slim-BRIEF.md:16` implies both repo and device travel in the handshake;
`:49` and acceptance item 4 at `:81` also imply repo is present in join accept. In fact,
`join-accept` contains only `type` and `mac`, and the master's new peer has `repo: null` until
an intent triggers a capability reply. This is pre-existing behavior, accurately described in
`docs/plans/join-slim.md`, and does not affect this feature's correctness. A follow-up docs
commit should align the brief with the plan: device is bound into the handshake, while
repo/head/role arrive via capability and then populate the master's status roster.

## Acceptance checklist

All nine items in `docs/plans/join-slim.md` were checked.

| Item | Result | Evidence |
|---|---|---|
| Paste is exactly `/join <NNNN-NNNN-NNNN> <host:port>` | PASS | `session.ts:506` formats code followed by the slash-quoted host. `join-args.test.ts` asserts the complete plain IPv4 string in “is just the code and the host”. |
| CLI twin is exactly `skep session join --code … --host …` and a POSIX shell reads it back | PASS | `session.ts:517` emits only these two flags in that order. Start-banner assertions check the plain twin; “shell-quotes the CLI twin” invokes `sh` and checks the resulting IPv6 arguments. |
| Paste round-trips for IPv4, IPv6, and DNS | PASS | The parameterized round-trip test covers `203.0.113.7:7419`, `[fe80::1]:7419`, `[::1]:7419`, `master.lan:7419`, and `h:1`, with no repo/device fields in parsed output. |
| Printed join hints omit `--repo`; the master's repo appears in prose | PASS | `joinHint` uses `repoLabel` and the two slim formatters; `startedText` delegates to it. Controller and shell assertions cover no-peers, rotation, peer-left, and own-join-ended hints. Help still intentionally lists `--repo` as an optional override. |
| CLI join with only code/host defaults repo and device | PASS | `session.test.ts:1860` joins from a temporary Git checkout without either override, checks normalized hostname `kris-macbook-local`, checks the checkout basename from `describe()`, and checks role `coding`. |
| TUI slim join uses the same defaults | PASS | `run.test.ts:721` submits `/join 1234-5678-9012 192.168.1.20:7419` from a temporary checkout, checks device and repo, and succeeds without either override. |
| Outside Git, omission of `--repo` fails with `repo_required` before connecting | PASS | `session.test.ts:1881` checks exit code 2, machine error code `repo_required`, actionable `pass --repo <name>` text, and zero `connectSub` calls. `joinSessionFlow` resolves repo at `session.ts:3071`, before connecting at `:3189`; the shell uses this same flow. |
| `JOIN_USAGE` leads with the slim form and makes overrides optional | PASS | `join-args.ts:22` lists slim, long, swapped, and bare forms, then all seven optional overrides. The usage test checks the leading forms and the optional repo/device declaration. |
| Lint, full tests, and build are green | PASS | Lint passed; the requested four files passed 260 tests; the full suite passed 725 tests in 32 files; build passed. See commands below. |

Source references in the table are under `src/cli/commands/` for `session.ts` and
`session.test.ts`, and under `src/cli/shell/` for the other files.

## Regression checks

- **Paste and IPv6 quoting:** `quoteSlashWord` makes bracketed IPv6 one double-quoted slash
  argument, while `quoteShellWord` single-quotes it for the CLI twin. The slash parser and
  POSIX-shell tests both round-trip the values. IPv4/DNS stay bare. In join hints, repo names
  with spaces and control characters are rendered as JSON-quoted prose instead of arguments;
  the spaces/newline tests cover this behavior.
- **All hint paths remain slim:** no-peers hints with a current code use `joinHint`; without
  one they use `/join <code> <host>` (`session-controller.ts:304`). CLI rotation
  (`session.ts:2739`), shell rotation (`run.ts:632`), and the master's peer-left hint
  (`run.ts:664`) use `formatJoinPaste` and the advertise address. The peer's own disconnect
  hint (`run.ts:825`) uses `/join <code>` plus its slash-quoted target. Corresponding output
  assertions passed. No generated paste/twin path appends a repo or device flag.
- **Legacy inputs still work:** only usage text/comments changed in `join-args.ts`; parsing
  logic is unchanged. Tests retain the old `--host … --code … --repo …` input, quoted repo
  overrides, positional swaps, bare joins, and manual/submit overrides. The shell test
  at `run.test.ts:431` joins with the old long form and a repo containing spaces. Existing
  CLI tests still exercise explicit repo/device flags through unchanged Commander options.
- **Old output expectations removed:** searching source/tests found no assertion requiring
  generated paste or CLI-twin output to contain the old `--repo` argument. Remaining old
  command strings are compatibility inputs, not expectations for generated hints. Assertions
  for `--repo` in usage/errors correctly remain because overrides are still supported.
- **Defaults preserve routing semantics:** repo is the Git top-level basename, including
  when joining from a subdirectory; device is the normalized hostname. Neither default
  implementation changed. A renamed checkout or master's explicit repo alias still needs
  a matching `--repo <name>` override for intent routing, as the plan explains. Successful
  connection alone does not promise a repo match.
- **Scope constraints:** `src/session/messages.ts`, `src/core/**`, session handshake/transport
  implementations, package metadata/lockfile, and version code are unchanged in the feature
  diff. No worktree setup or mandatory AGENT.md gate was introduced. Changes are limited to
  the four intended CLI modules, their tests, and documentation; the additional annotation
  in `join-paste-auto.md` marks the superseded format. Version remains `0.1.11`.

## Wire claim

Confirmed unchanged against the baseline with an empty diff for `src/session/messages.ts`
and `src/core/**`; `sub.ts`, `master.ts`, and `handshake.ts` are also unchanged.

1. `src/session/messages.ts:39` defines the strict first join frame as
   `{ type: "join", v: 1, device, pub, nonce }`.
   `src/session/sub.ts:363` sends that frame with `device: o.device`.
   `src/session/handshake.ts:101` includes device in the transcript used to derive keys.
   The join code is used in key derivation and is not sent as a clear frame field.
2. `src/cli/commands/session.ts:3203` supplies `describe()`, returning `{ repo, role, head }`.
   Upon an intent, `src/session/sub.ts:176` calls it, validates the description, and sends
   `{ type: "capability", intentId, repo, head, role }`. The schema is at
   `src/session/messages.ts:208`.
3. `src/session/master.ts:551` initializes repo/head/role to null on joining. Receipt of a
   capability at `:616` sets these fields; status exposes repo at `:356`. Thus repo travels
   after the handshake, in response to an intent, rather than on join or join accept. This
   behavior predates JOIN-SLIM.

The two new default-join tests inspect injected `connectSub` options and `describe()` rather
than observing a real master's roster. Their evidence is supported by the unchanged wire
implementation and the passing full suite. No real agent CLI or external-device smoke test
was performed.

## Validation

The existing `node_modules` symlink was usable; no dependency installation was necessary.
All commands completed with exit code 0:

```bash
npm run lint && npx vitest run src/cli/shell/join-args.test.ts src/cli/commands/session.test.ts src/cli/shell/run.test.ts src/cli/shell/session-controller.test.ts
npm test && npm run build
```

- Lint: Biome checked 84 files without fixes; TypeScript checking passed.
- Requested focused tests: 4 files, 260 tests passed.
- Full suite: 32 files, 725 tests passed.
- Build: TypeScript emit and agent-guide asset copy passed.
- Built JavaScript: an additional IPv6 check confirmed the exact quoted paste/twin strings
  and successful slash-parser round-trip.

## Suggested fix commits

No mandatory fix commits: the verdict is not FAIL. Optional follow-up for N1:
`docs(session): clarify capability metadata in JOIN-SLIM brief`.

This review changes only `docs/reviews/join-slim.md`. Product source was not edited; no
push, merge, publication, or version bump was performed.
