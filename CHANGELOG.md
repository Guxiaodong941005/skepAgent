# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While 0.x, a **minor** bump may break CLI flags, config or the blackboard protocol, and a
**patch** bump may not. A protocol or reducer change additionally follows
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4.4: a new `REDUCER_VERSION` needs golden
evidence, and a live blackboard needs a human re-genesis.

## [Unreleased]

## [0.1.1] - 2026-10-09

Session mode and the local agent view, on top of the v0.1.0 blackboard. Package name stays
`@skepagent/skep`. `npm publish` is still deferred. See [`docs/RELEASE.md`](docs/RELEASE.md).

### Added

* In-memory session protocol: `skep session start`, `join`, `intent` and `status`. A master
  plans items; subs work them and submit their own results. The master receives status plus a
  redacted summary (at most 4000 characters); the full transcript stays on the executing device
  (D27).
* Live agent view in `skep session join`: PTY attached to the human's terminal, optional local
  herdr pane (`herdr agent focus`), then the native non-interactive CLI. A `blocked` agent is
  never auto-approved (D28, D29).
* Dependency-free TUI (`skep ui`, `skep session join --ui`): peers, the current item, agent
  state, the redacted output tail and the submit choice. One agent occupies the terminal;
  several agents are a list (D30).
* Executing-device submit policy (`device.toml` `submit.method` / `submit.host`): ask, pr/mr,
  push, none. Subs apply it locally; Skep still never auto-merges.
* PTY runner and thin herdr session client (`src/runtime/pty.ts`, `src/runtime/herdr.ts`).
  herdr is optional and never embedded.

### Changed

* Bare `skep` (no subcommand) opens the local agent CLI — claude, then codex, then pi — with
  Skep's guide as the first message. `skep tui` does the same. The agent keeps its own TUI;
  Skep does not approve tool use.
* Product UX for this tag is the session TUI plus locally installed agent CLIs. The signed
  blackboard, daemon and `skepd` from 0.1.0 are unchanged. `REDUCER_VERSION` and
  `protocol_version` stay 1.

### Known limitations

* **SK-609 real two-device acceptance was waived for v0.1.0** on 2026-10-09 and is still not
  done. `docs/MVP-RUN-REPORT.md` does not exist. This tag is an early snapshot, not a production
  gate.
* **No `npm publish` yet.** Install from git (`github:Guxiaodong941005/skepAgent#v0.1.1`) or
  clone and build. Publishing `@skepagent/skep` waits for the human to create the npm org
  `skepagent` and give an explicit go.
* Codex, Claude and pi are used only when installed locally (D19). herdr is optional.
* macOS and Linux only. Single execution slot per device.
* Wave 7 (optional hint relay, enrollment/trust bundles, remote `skep logs`) is not in this tag.
* Moving an item to another agent needs a revoke plus a human-approved replan (G2).
* `skep sim run` outside a source checkout cannot resolve fixture keys under `test/` (G4).
* `gitleaks detect` over full history still reports a dummy `ssh-ed25519` body in
  `src/git/trust.test.ts` (G18). Only `test/fixtures/keys/` is allowlisted.
* `skep -V` still prints the scaffold string `0.0.1`. Package version `0.1.1` lives in
  `package.json`.
* Manual lease revoke; no auto-merge. The human holds plan approval, escalation decisions and
  merges.

## [0.1.0] - 2026-10-09

First public tag of the Skep MVP (PRD §16). Tag-only: `npm publish` is deferred until the human
creates the npm org `skepagent` and explicitly says go. See [`docs/RELEASE.md`](docs/RELEASE.md).

### Added

* Signed git blackboard: linear `main` event log, SSH-signed commits, local `allowed_signers`
  trust root, fetch/reset/recompute/push write path, heartbeats on `hb/<agent>` refs.
* Deterministic reducer (`REDUCER_VERSION` 1, `protocol_version` 1) with golden fixtures, epoch
  fencing, authz, preconditions and invariant checks. Two devices at the same tip compute
  byte-identical state.
* Epoch-fenced leases: claim, revoke, re-verify before delivery, suspend detection, parked
  leases under a barrier (D16).
* Per-device daemon (`skepd`): tick loop, single-daemon lock, plan/review/claim/execute slots,
  coarse replan, stacked delivery and top-of-stack verification, Unix-socket IPC with optional
  `--socket-group`.
* CLI (`skep`): `init`, `doctor`, `task`, `plan`, `replan`, `lease`, `decide`, `status`, `log`,
  `agent`, `pull`, `sim`; `--machine` JSON; in-process publisher fallback when the daemon is down.
* Codex adapter (pinned CLI, structured output, local login only). Fake adapter and deterministic
  simulation harness (`skep sim run`) for protocol scenarios.
* Stacked pull requests on the code host (`gh`): dependents start from the predecessor SHA, merge
  observation retargets the next PR, owner publishes `task.verified`.
* Pattern-based redactor plus gitleaks before every publication; `work.failed{secret_detected}`
  on a hit with no secret material in the event (D25).
* Service units (`deploy/skepd.service`, `deploy/com.skepagent.skepd.plist`) and
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
* Outbound-only networking (D18): hosted git is the only rendezvous; no inbound connectivity or
  mesh VPN required. Optional hint channel is availability-only.
* Hard rule D19: Skep never transports, stores, syncs or brokers provider credentials.

### Changed

* Package name is the scoped `@skepagent/skep` (unscoped `skep` is an unrelated npm package).
  Bin names stay `skep` and `skepd`. `"private": true` is removed so a later `npm publish` can
  proceed; this tag does not publish.
* Wave 6b hardening is on `main`: agent-originated replan requests (SK-611), socket group/mode
  (SK-612), restart/verification/code-host recovery (SK-613), polish and runbook (SK-614).

### Security

* Every authoritative write is SSH-signed and verified against the **local** trust root.
  Unsigned, forged or malformed commits are no-ops and raise an alarm.
* D19 (verbatim): **Skep never transports, stores, syncs or brokers provider credentials, API
  keys or provider configurations between devices, in any form: not as plaintext, not as
  ciphertext, not as a hash, and not as a label.** Each device's agent CLIs are configured
  locally by the human on that device; Skep neither reads nor records that configuration.
* D18 transports (git remote, optional wake-up hints, controller `skep pull` nudge) are
  availability-only and never carry secrets or payloads.
* Leak defence in depth: gitleaks + pattern redactor on everything Skep writes or publishes.

### Known limitations

* **SK-609 real two-device acceptance was skipped for this tag.** The user explicitly waived
  SK-609 for v0.1.0 on 2026-10-09. `docs/MVP-RUN-REPORT.md` does not exist; PRD §16.5 has not
  been verified on two real devices. Treat this tag as an early MVP snapshot, not a production
  gate.
* **No `npm publish` yet.** Install from git (`github:Guxiaodong941005/skepAgent#v0.1.0`) or
  clone and build. Publishing `@skepagent/skep` waits for the human to create the npm org
  `skepagent` and give an explicit go.
* Codex adapter only. No herdr runtime backend (added in 0.1.1).
* macOS and Linux only. Single execution slot per device.
* Wave 7 (optional hint relay, enrollment/trust bundles, remote `skep logs`) is not required
  and is not in this tag. Wave 8 session-mode / TUI work is **not** in this tag (it lands in
  0.1.1).
* Moving an item to another agent needs a revoke plus a human-approved replan (G2). There is no
  reassign event; claims require the plan assignee. See `docs/RUNBOOK.md` §4.1.
* `skep sim run` outside a source checkout cannot resolve fixture keys under `test/` (G4). The
  published pack does not ship `test/` or keys; run the simulator from a git checkout, or expect
  an actionable failure when those files are missing.
* `gitleaks detect` over full history still reports a dummy `ssh-ed25519` body in
  `src/git/trust.test.ts` (G18) plus historical session-mode test tokens that are not in this
  tree. Only `test/fixtures/keys/` is allowlisted.
* `skep -V` still prints the scaffold string `0.0.1`. Package version `0.1.0` lives in
  `package.json`; `REDUCER_VERSION` and `protocol_version` are 1. Reading them from the package
  metadata is a follow-up (the CLI version string is owned by SK-104).
* Manual lease revoke; no auto-merge. The human holds plan approval, escalation decisions and
  merges.

[Unreleased]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Guxiaodong941005/skepAgent/releases/tag/v0.1.0
