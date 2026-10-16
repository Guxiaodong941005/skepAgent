# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While 0.x, a **minor** bump may break CLI flags, config or the session protocol, and a
**patch** bump may not. Releases 0.1.0 and 0.1.1 also shipped the signed git blackboard; its
protocol rules ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4.4) apply to those tags only.

## [Unreleased]

## [0.2.0] - 2026-10-16

Skills: trusted bundles and staged dispatch ([`docs/plans/skep-skills-iot-workflow.md`](docs/plans/skep-skills-iot-workflow.md), D36).

### Added

* **Skills (SKILL-MVP).** Packaged TypeScript skill modules plus on-disk user (`~/.skep/skills/`)
  and project (`.skep/skills/`) bundles. A skill supplies scene-fit prompts, roles, optional
  stages and checks; it does not change agent tools, approvals or session wire fields.
* **Selection.** `/skills`, `/skill use|off|bind|unbind|show|trust`, `/start --skill <id>`,
  and `skep session start --skill <id>`. Project skills require `/skill trust` once per
  SHA-256 content digest. `/skill use <id> --default` saves a project default.
* **Staged dispatch.** When a skill defines stages, the master settles each stage before the
  next (earlier results and changed-file lists appended as untrusted context). An empty stage
  list keeps single-wave dispatch. Required unbound roles block dispatch; optional roles are
  reported skipped.
* **Example skill `iot-ble-feature`.** Roles `device` / `server` (required) and `ios` /
  `android` / `h5` (optional); stages `contract → providers → clients`. Not the CLI default.

### Changed

* **CLI default skill remains `generic`**, equivalent to v0.1.15 refine and dispatch. `/intent`
  stays raw; `/orchestrate off` ignores the active skill.

## [0.1.15] - 2026-10-14

License-only republish; no product feature, CLI, config or protocol changes.

### Changed

* The relicense from MIT to Apache-2.0 is already on `main` (`2415290`). This release
  republishes the package so the npm `license` field reads `Apache-2.0`; the registry still
  showed `MIT` for 0.1.14.

## [0.1.14] - 2026-10-13

Master orchestrator, TUI scrolling and multi-peer panels (SCROLL, ORCH Phases 0–7,
[`docs/plans/tui-scroll-and-herdr-controller.md`](docs/plans/tui-scroll-and-herdr-controller.md)).
Session protocol v2 is negotiated; ≤0.1.13 peers and masters keep working on v1.

### Added

* **TUI scrolling (SCROLL).** The shell transcript is scrollable with a pinned viewport
  (PgUp/PgDn and the mouse wheel; new output does not yank a scrolled-back view), and
  `/top` / `/bottom` jump to either end. `skep ui` gains a scrollable OUTPUT pane. Peers now
  receive full results, peer output and the intent text.
* **Master orchestrator (ORCH-2..4, ORCH-7).** Free text in the master shell is refined by the
  master device's own agent CLI (claude, codex or pi, resolved like `/join`; read-only turns)
  into a brief, dispatched through the same route as `/intent`, and the settled results are
  synthesized by the same agent conversation. Multi-repo goals become one brief per target
  repo, partial failures are named, and long results fold (`/expand`, `/fold`).
  `/orchestrate [auto|confirm|off|new]` (default `auto`; `off` is the v0.1.13 behavior,
  `SKEP_ORCHESTRATE` overrides per process), plus `/summarize`, `/cancel` and `/history`.
* **Session protocol v2 (ORCH-6).** A sub opens with `join{v:2}`; a ≤0.1.13 master refuses it
  before any key exchange and the sub retries once on v1. v2 adds releases in
  `welcome`/`peer-info`, briefs up to 8000 characters (v1 peers get the first 4000, marked),
  a changed-files list (paths, change kind, line counts; never content) on each result, and
  opt-in live output (`/share-output on`, `/join … --share-output`,
  `skep session join --share-output`; default off, per join, never stored) limited to
  20 lines / 2 KB per frame and one frame per 500 ms. `skep session status` gains a SKEP
  column.
* **Split panels for multi-peer joint debugging (ORCH-5).** `/layout split` shows a main panel
  plus one panel per connected peer (side by side from 100 columns, stacked below). Tab or
  `/focus <main|peer|device>` picks the panel to scroll, `/zoom` shows it alone, `/find`
  scrolls it back to text. Panels are Skep's own views of the one transcript, not herdr panes.

### Fixed

* **A join code absorbs 8 wrong tries.** A wrong or stale code no longer rotates the code at
  once and cancels other joins in flight; the 8th miss rotates it. A proved code still rotates
  at once. The master shows no miss counter (user-confirmed).
* **`/start` invites peers from any repo.** The banner says "from a checkout of any repo"
  instead of naming only the master's repo.
* **Peer `/status` shows other peers' repos.** v2 progress relays carry the repo, so a peer
  lists `alpha-app`, `beta-svc` and so on rather than `?`.
* **Seven UI bugs from the Phase 3 exit run:** failed runs say "failed N of M"; a v2 peer names
  its repo and role in `peer-info` so the master routes by them at once; join rejections say
  why and how to fix; rotated codes are no longer logged in the main panel; the `/start` text
  describes per-repo routing; progress lines cut at a word boundary; `/expand` and `/fold`
  confirm what changed.

### Changed

* **Unreleased builds use a `-dev` suffix** (for example `0.1.13-dev`) so they are distinguishable
  from the published release; this release is plain `0.1.14`.

## [0.1.13] - 2026-10-13

### Fixed

* **Lone peer takes a bare intent (INTENT-PEER).** With exactly one connected peer, an intent
  without `--repo` is routed to that peer's repo even when it differs from the master's (master
  in `futrobomower`, peer in `skepAgent` used to fail with `no_match`). An explicit `--repo`
  that no peer works on still fails with `no_match`.
* **TUI `/intent --repo` is honoured.** `/intent --repo <name>... <text>` passes the repos to
  the master (own or over the control port); before, the flag was sent as part of the text and
  the master's own repo was used. Free text is never flag-parsed.

### Added

* **Peer picker for intents.** With more than one connected peer and no `--repo`, Enter on
  `/intent <text>` or free text opens a multi-select of `peerId  device  repo` (↑/↓ move,
  Space toggle, Enter send with at least one selected, Esc cancel). One intent is sent with
  the selected peers' unique repos. No wire change.

## [0.1.12] - 2026-10-12

### Changed

* **Slim join paste (JOIN-SLIM).** The line a master prints is now just the code and the host,
  `/join 1234-5678-9012 203.0.113.7:7419`, and its CLI twin is
  `skep session join --code 1234-5678-9012 --host 203.0.113.7:7419`. Neither carries `--repo`:
  the peer's repo defaults to its git top level's directory name and its device to the
  hostname. The master's repo is named in prose ("from a checkout of app"). `--repo`,
  `--device`, `--role`, `--agent`, `--view`, `--submit` and `--manual` stay optional
  overrides, and old `/join --host … --code … --repo …` lines still parse. No wire change.

## [0.1.11] - 2026-10-12

Session UX rethink (SESSION-UX, [`docs/plans/session-ux-rethink.md`](docs/plans/session-ux-rethink.md)):
a peer's agent edits the project folder directly, the agent is found at `/join` or the join
fails, and the master shows what changed instead of a branch name. No session wire change.

### Changed

* **No worktrees, clones or session branches.** Items run in the peer's project root (the git
  top level of the joined directory, or the directory itself) and strictly one at a time per
  peer. `<home>/session/worktrees` is no longer created.
* **No AGENT.md requirement.** The agent CLI is resolved once at `/join`: `--agent
  <claude|codex|pi>`, then `/agent` (saved in this project's `device.toml` `[agent] cli`), then
  `SKEP_AGENT_CLI`, then an `AGENT.md` that happens to exist, then the first of `claude`,
  `codex`, `pi` on `PATH`. If none is found the join fails with one cause and one fix.
  `--role-dir` is accepted and ignored.
* **`--agent` takes the agent CLI; `--view native|pty|herdr|dry` takes the run view** (default
  `native`). The old `--agent pty|native|herdr|dry` values are refused with the replacement
  flag. `SKEP_SESSION_EXEC` no longer does anything; `SKEP_SESSION_VIEW` still sets the view.
* **Results are deltas.** Each item reports the files whose content changed during the run,
  a diffstat and the agent's own closing summary (`I-1 done · mac (app) · claude · 2m 14s`).
  A dirty tree is never stashed, reset or cleaned; files that were already modified are
  annotated `(was already modified)`.
* **Submit modes work on the delta.** `none` (default) leaves the edits in the folder; new
  `commit` commits only the item's files on the current branch; `push` also pushes that
  branch; `pr`/`mr` copy the files onto a new `skep/<item>-<slug>` branch (created only then),
  push it and open the PR/MR without touching the working tree or the checked-out branch.
  `skep session submit` works on the recorded delta; a legacy `skep/session/*` branch gets a
  clear "use git directly" message and is never deleted.
* `/clean` says that nothing is left on disk; there is no git state to clean.
* `/status` shows a roll-up per intent (`2 done · 1 failed · 4 files changed`) and each
  item's full result, wrapped, never cut; the master prints one final block per intent:
  `intent-done` only when everything succeeded, `intent-failed` when an agent or a submit
  failed, `intent-waiting` while a herdr agent waits for the human. Failed submits, waiting
  agents and declined items are counted apart from `done`.
* A blocked herdr agent keeps its place in the item queue until it finishes or the join
  closes; the next item starts only after it, and its record covers what it wrote afterwards.
* `skep session submit` refuses, changing nothing, when a recorded file changed after the
  item (a later item or a hand edit); changes the agent already committed still push.

### Added

* `skep session undo <item> [--force]` and `/undo <item>`: put the files an item changed back
  to their content from before it. Refuses, changing nothing, when a file changed again after
  the item, unless `--force`. Symlinks are removed or recreated as links, never written
  through, and only recorded paths are touched. Every run of an item id replaces its record,
  so a later session's `I-1` that changed nothing never undoes an earlier session's `I-1`.

### Removed

* The dry-run marker commit (`.skep-session-item`). `--view dry` runs nothing, commits
  nothing and reports a failed-class `DRY RUN: no agent ran, nothing changed`.

### Fixed

* A second session on the same device no longer fails with `materialize: … already exists;
  submit or delete it first` (item ids restart per session).
* Errors are readable: error and warning lines in the shell wrap with a hanging indent
  instead of being cut at the terminal edge; failed items show one cause and one fix, the
  master never caps a `FAILED` block, and the full text is written to
  `<home>/session/last-error.log`.

### Upgrading from 0.1.x

* Worktrees and `skep/session/*` branches left by earlier versions are yours: run
  `git worktree prune` once and delete old branches with git if you no longer need them.

## [0.1.10] - 2026-10-12

Peers on the same machine stay connected through intents even when the join directory has
no usable Git HEAD (`--repo` is only a routing label).

### Fixed

* Session join `describe` / datalist callbacks no longer close with `callback_error` when
  local `git rev-parse HEAD` or tracked-file listing fails (unborn HEAD, non-Git cwd, or
  invalid SHA). The peer warns, reports the unknown forty-zero SHA / empty datalist, and
  can answer further intents; real work still fails with a typed Git check when the
  checkout cannot run.

## [0.1.9] - 2026-10-12

Per-project session isolation and automatic port picking so several projects can run
skep on the same machine without sharing `~/.skep` or colliding on port 7419.

### Added

* Automatic project isolation: default state lives in `~/.skep/projects/<projectId>`, where
  the ID hashes the canonical Git toplevel (or cwd outside Git). Same-project terminals keep
  local discovery and bare `/join`; peers in other checkouts use the master's full join line.
  Explicit `--home` / `SKEP_HOME` remain exact. The legacy global home is not auto-migrated;
  select `SKEP_HOME="$HOME/.skep"` or `--home "$HOME/.skep"` to keep using it.
* Session starts without `--listen` try LAN IPv4 port 7419, then available ports through 7519
  when busy. Advertise and pasteable joins use the actual bound port; explicit `--listen`
  addresses are never silently changed.

### Fixed

* Session start errors explain automatic project defaults, shared-home overrides, and explicit
  port collisions or exhaustion of the automatic port range.

## [0.1.8] - 2026-10-10

Join UX for the unified shell: pasteable `/join`, peer auto mode, submit default `none`, and agent summaries on the master.

### Added

* Shell command `/clean` (alias `/clear`): ends this shell's master and join, cancels a join
  still in its handshake, and removes a `session.json` whose master no longer answers, then
  returns to `no session` without leaving the shell. A live master in another process is never
  stopped. `/join` while joined now points at `/clean` (leave the session) vs `/quit` (leave the
  shell).
* Pasteable join line: `/start` and `skep session start` print
  `/join --host <host:port> --code <NNNN-NNNN-NNNN> --repo <repo>` for the peer's skep shell, plus
  its `skep session join …` twin. The same line is printed again when the code rotates, when an
  intent finds no peer, and when a peer leaves. `/join` usage leads with this form. A repo
  name with spaces or special characters is double-quoted (slash arguments now understand
  `"…"` with `\"` / `\\` escapes) and single-quoted in the shell twin, so the line parses
  back to the same values. A repo with control characters is left out, with a note.
* `--advertise <host:port>` on `/start` and `skep session start`: the address peers dial (NAT,
  public IP, relay). The paste line uses it; `--listen` stays the bind address. Both must name
  a valid hostname (no empty labels), IPv4 or bracketed IPv6 address, checked with Node's IP
  parser; wildcards and unspecified addresses (`*`, `0.0.0.0`, `::`, also with a zone id),
  blank or malformed hosts are refused before any master starts.
* Peer control mode. A join is **auto** by default: master-driven items run without a skep
  prompt; only an explicit `ask` submit policy may still ask (`--submit` / `device.toml`
  `submit.method`).
  `/join … --manual` and `skep session join --manual` opt out: each item is confirmed
  (`[Y/n]`) before it runs, and a declined item is reported as skipped without a checkout.
  The joined line names the mode. `/clean` drops a pending item question and any queued
  behind it. Agent CLI approval prompts are untouched (D29).
  `--manual` is not available with `--ui` yet.
* `/join --submit pr|mr|push|none|ask`, as on `skep session join`.
* The session master's shell scrollback shows the peer agent's summary when it accepts a result:
  `item I-4: <summary>`, already redacted, capped at the first 8 non-empty lines and 600
  characters (` …` marks a cut). A rejected result is logged as `result rejected I-4: <reason>`.
  Progress ticks still only redraw the footer.

### Changed

* The session submit policy defaults to **`none`** instead of `ask`: when `device.toml` is
  missing, has no `[submit]`, or does not parse (also an unknown method), a finished item is
  committed on its local session branch and nobody is prompted `Submit this item?`. `--submit`
  and `device.toml` `[submit] method = "ask"` (or `pr`/`mr`/`push`) still choose otherwise; host
  `git` still forces `push`. The full device schema's `submit.method` default is unchanged.

## [0.1.7] - 2026-10-10

TUI and session reliability for the unified shell: single session truth, ergonomic `/join`, clearer intents, peer presence.

### Fixed

* Shell session state has one source of truth (`SessionController`): the header, peer footer,
  slash gating, `/status` and intents read the same snapshot. Peer rows from a join that ended
  are dropped, and a session master running in another process on the same device is detected
  and used instead of reporting `no session`.
* A master in another process is bound by identity (its control endpoint and token). An intent
  typed in the shell goes only to the master it shows: if another master is published, the
  endpoint refuses the connection, or it rejects the token, the intent is not delivered and the
  shell says which master it shows now. If the intent was sent but no reply came back (connection
  lost, timeout, malformed reply), the shell says it **may have been accepted**, points at
  `/status`, and warns that sending it again could duplicate the work.
* `skep session intent` reports a lost reply as `intent_outcome_unknown` (the intent may exist)
  instead of `session_unreachable`, which now means the request never reached the master.
* A failed or ended join (and an ended own master) re-discovers a master still running in
  another process instead of falling back to `no session`. Only the newest discovery applies,
  so an older, slower probe can no longer clear or resurrect the master shown.
* `/join` rejects a repeated `--host` or `--code` instead of using the last one.
* `/join` accepts `/join <host:port> <code>` (either order), `/join <code> --host <host:port>`,
  `/join --host <host:port> --code <code>` and `/join <code>`; other forms are rejected with the
  list of accepted forms instead of `--code must be 12 digits`.
* Intents with no joined peer are refused in the shell with the `/join` command to share,
  instead of being recorded as `no_match` with `Unable to route the session intent`. A
  `no_match` now says which repo no peer works on (shell, `skep session intent`).
* `skep session intent` waits up to 40 s for the master's answer, which may itself wait 30 s
  for peers' capabilities; it no longer reports a live master as unreachable.
* The master names the peer, device and reason when a peer leaves (`Peer peer-2 (mac) left:
  heartbeat_timeout`) and no longer logs a `disconnected` event for every control request. A
  joined shell shows sub-side errors and why it left, with how to rejoin.

### Added

* Heartbeat display in the shell: per-peer time since last heard on a master, master link age on
  a peer, flagged `quiet Ns` after 20 s of silence (`MasterHandle.presence()`,
  `SubHandle.silenceMs()`).

## [0.1.6] - 2026-10-10

Unified Skep shell (Grok Build–style): one screen for every open, slash commands, bee progress under the input. Codex UI chrome merged in.

### Added

* Unified Skep shell: bare `skep` opens one screen with a header (logo, version, device, cwd,
  session state), a scrollback of session events, an input box with a `/` command menu, and the
  bee strips of peer progress under the input. Commands: `/start`, `/join [code] [--host]`,
  `/status`, `/intent`, `/agent`, `/help`, `/quit` (`/exit`). Text without `/` goes to this
  device's session master as an intent. Join prompts and submit choices are answered in the
  input box. Item agent states and output tails appear in the scrollback.
* `startMasterFlow`, `joinSessionFlow`, `submitIntent` and `fetchSessionStatus` in
  `src/cli/commands/session.ts`: the bodies of `skep session start|join|intent|status` without
  Commander, signals or blocking, so the shell runs the same code paths as the CLI.

### Changed

* Bare `skep` no longer launches the agent's own fullscreen TUI, and no longer takes a prompt
  argument (`skep some words` is now a usage error). `skep tui [prompt]` still opens the raw
  agent TUI as the explicit escape hatch.

## [0.1.5] - 2026-10-09

Peer progress and a redesigned session screen. Versions 0.1.3 and 0.1.4 were never released.

### Added

* Peer progress over the existing encrypted session channel: a new `progress` session message.
  A sub reports its own phase (`idle`, `working`, `blocked`, `done`) and the title of the item
  it is on. The master rebuilds every relay from its own state, fills in the subject's
  `peerId`/`device`/`role` from the authenticated connection, and sends it to every other
  opted-in peer, never back to the subject. A disconnected peer is announced with
  `phase: "left"`. `SessionStatus.peers[].progress` carries the same strip for `skep ui`.
  `SubOptions.onProgress`, `SubOptions.progress` and `SubHandle.reportAgent` expose it to the
  CLI. The heartbeat stays liveness-only.
* Progress metric (MVP): `percent = floor(100 * done / total)` over the items assigned to the
  peer. An item counts as done once its result is accepted or it failed (dropped assignee). It
  counts as failed when it failed or a check reported `fail`. The master derives the counts, so a
  sub cannot inflate its percentage. A reported `blocked` wins, even at 100 %: the code is in,
  but a human still owes an answer or a submit. Summaries are only master-sent item titles,
  re-redacted by the master and capped at 120 characters.
* Rate limits: at most one progress frame per subject every 500 ms, on both sides. Phase
  changes go out at once, unchanged values are dropped, and changes inside the window collapse
  into one trailing frame with the latest value.
* Peer progress strips in `skep ui` and `skep session join --ui`: an animated bee
  (Nerd Font `nf-md-bee` / `bee-flower`, `beehive` when done) with an eight-cell bar,
  percentage, `done/total`, phase and summary. Without a Nerd Font, or with
  `SKEP_TUI_GLYPHS=ascii` (legacy `SKEP_TUI_ASCII=1`), it falls back to ASCII (`~b>`, `#`/`.`).
* Semantic color theme for the session screen (`src/cli/theme.ts`): Material-style roles
  (primary honey, on-surface, variant, outline, secondary, tertiary, success, warning, error)
  with a dark and a light palette. Text roles meet WCAG 4.5:1 and the outline 3:1, checked by
  tests.
* `SKEP_TUI_COLOR` (`auto`, `never`, `16`, `256`, `truecolor`), `SKEP_TUI_THEME` (`auto`,
  `dark`, `light`) and `SKEP_TUI_ANIMATE=0` (stops the bee animation). `NO_COLOR`,
  `FORCE_COLOR`, `COLORTERM`, `TERM` and `COLORFGBG` are honored when detecting the color
  level and palette.

### Changed

* Redesigned session screen. A one-line header shows the brand, session, device, role and
  version. `PEERS`, `ITEM` and `OUTPUT` are labeled rules. Device and role columns are aligned.
  Every state is a colored chip that keeps its word (`blocked`, `done (1 failed)`), so the
  screen reads the same without color. The footer lists only the keys that act now, puts
  pending submit keys in the warning color, and shows the selection's position. Empty states
  say what is happening. The header and footer are no longer inverse bars: inverse marks the
  selected row only.
* Narrow terminals shed detail in order: below 70 columns the `done/total` count goes, below
  60 the bar goes (the percentage stays), and the header drops the version, then the role.
  ASCII mode uses no ambiguous-width characters for rules and separators.
* Focus and code-host failures are shown as `! …` messages in the error color.
* `skep -V` prints the package version (from `src/cli/version.ts`).

### Compatibility

* Opt-in: a master sends `progress` only to subs that have sent one, so a 0.1.2 sub stays
  connected. Its strip is still derived by the master and shown to the other peers.
* A 0.1.5 sub cannot join a 0.1.2 master: the old master rejects the unknown `progress` frame
  right after `welcome`. Upgrade the master device first; all session devices should run
  ≥ 0.1.5.
* Anything that scraped the alternate screen will see new strings. Row positions are
  unchanged, and the screen was never an interface.

## [0.1.2] - 2026-10-09

Session mode only. The signed git blackboard from 0.1.0 is gone.

### Removed

* Signed git blackboard protocol, `skepd` daemon, and related CLI (`init`, `task`, `plan`,
  `pull`, `replan`, `lease`, `decide`, `status`, `log`, `logs`, `doctor`, `sim`, role-slot
  `agent`, …).
* Deploy units (`skepd.service`, launchd plist).

### Changed

* What remains: session mode (`skep session start|join|…`), `skep ui`, and bare `skep`, which
  opens the local agent TUI. Join-code collaboration works across devices and across
  directories on one machine.

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

[Unreleased]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.15...v0.2.0
[0.1.15]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.2...v0.1.5
[0.1.2]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Guxiaodong941005/skepAgent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Guxiaodong941005/skepAgent/releases/tag/v0.1.0
