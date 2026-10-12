# Same-machine multi-project sessions (MULTI-PROJ)

## Finding and scope

The working directory selects the default repo name, but it does not select the local session.
In 0.1.8, every invocation by the same user defaults to `~/.skep`, with one `session.json`
control pointer and the same default listener port, 7419. Two project directories therefore
share session discovery and compete for the same listen address. Independent masters already
work with separate homes and separate listen endpoints; two concurrent `/start` commands with
all defaults are not supported.

This report concerns the live, in-memory session CLI and unified shell. The older signed
blackboard daemon has its own one-daemon-per-home lock and socket. ARCHITECTURE §3 and §12
describe the shared home and those daemon files; DEV-PLAN Wave 8 describes the live session
execution path. PRD §7.1's role-by-directory rule does not imply a session namespace per
directory. The current live behavior below is traced from the 0.1.8 source.

## What happens, step by step

1. Terminal A runs `cd /proj-a && skep`. `src/config/paths.ts` resolves the home using
   `--home`, then a nonempty `SKEP_HOME`, then `~/.skep`. The cwd is absent from that decision.
2. A runs `/start`. `startMasterFlow` in `src/cli/commands/session.ts` defaults `repo` to the
   basename of `git rev-parse --show-toplevel`, chooses a LAN IPv4 address (or loopback) on
   port 7419, and probes the selected home's `session.json`. With no live recorded master,
   it binds, then atomically writes `{listen, token}` to `~/.skep/session.json` with mode 0600.
   The random token identifies this master; the file contains neither repo nor a session list.
3. Terminal B runs `cd /proj-b && skep`. Its home is still `~/.skep`.
   `Shell.probeExternal` reads that same pointer and asks A for status. If A answers, B displays
   A as `master (other process)` even though B's cwd is a different project. `/status` describes
   A, and accepted free text or `/intent` goes to A's displayed endpoint and token.
4. B runs `/start`. The shared start flow calls `refuseIfRunning` before binding. A answers the
   `status` probe, so B fails with `session_running`. B does not overwrite the pointer and
   does not attempt a second bind. Changing `--repo` or `--listen` alone still hits this guard.
5. If B instead selects another home, it bypasses A's pointer, but its default listener is
   still the same host and port 7419. A second bind fails with `EADDRINUSE`. In the original
   code this surfaced only as `Unable to bind session listener`, hiding the cause. No B
   pointer is published after a failed bind. `--advertise` changes the address peers dial,
   not the address the master binds, so it cannot resolve this conflict.
6. With both another home and an unused listen endpoint, B can start an independent master.
   Its status/intent commands must keep using that home, and its peers must dial B's endpoint.

Changing directory after opening a shell does not switch its context. Likewise, starting only
a master provides no worker: an intent still needs a joined peer, including a self-joined peer
if that is the intended setup.

## Single pointer, overwrite risks, and cleanup

Ordinary sequential starts preserve the first pointer because the live-master check rejects
the second start. There is no repo-indexed registry or exclusive start lock for `session.json`:

* Two starts can both probe before either publishes. With the same bind endpoint, one loses
  the bind. With different endpoints but the same home, both can bind and the last atomic
  publication replaces the first pointer. Later shells and CLI control commands discover only
  the last published master, while the earlier shell can still operate its own master directly.
* A missing, corrupt, unparseable-address, or unreachable recorded pointer permits a new start.
  A timed-out or malformed probe can also be treated as unreachable; that does not establish
  that the old process has stopped. A different listen endpoint can then allow both processes
  to survive while only one remains discoverable. A well-formed control error reply, including
  `bad_token`, currently counts as a response and refuses the new start.
* Clean shutdown removes only a pointer carrying that master's token. Cleanup moves the file
  aside and restores a replacement without overwriting a newer publication. This protects the
  replacement pointer, but does not make multiple masters sharing one home supported.
* `/clean` stops masters/joins owned by that shell and removes demonstrably stale pointers.
  It preserves a live master in another process. Running it in B therefore does not release A's
  home or port. It also does not delete saved branches, worktrees, or transcripts.

The shell binds an external intent to the endpoint and token it displayed and detects later
pointer replacements. That protection prevents sending to an unseen replacement, but does
not determine whether the initially discovered master belongs to B's cwd. A master for project
A can legitimately receive B's free text when both invocations use A's home.

## Repo routing and peer state

`defaultRepo` uses the git toplevel's basename, not its full path, origin, or commit history.
`--repo` overrides this logical routing label; it does not isolate files or listeners.
`src/session/state.ts:matchSub` matches exact repo strings and selects the earliest matching
joined peer. The master's own directory is not an executing peer.

By default, intents target the master's repo. If A starts as `proj-a` and B joins from a repo
named `proj-b` without a repo override, B advertises `proj-b`: it cannot take an intent for
`proj-a`. With no matching peer, the outcome is `no_match`; the shell refuses an intent even
earlier when no peers have joined. Conversely, unrelated repositories with the same basename
can look like the same repo to routing. Use meaningful, distinct `--repo` labels, and give a
peer the master's label only when its checkout is actually intended to work on that repo.

Peers do not bind a master listener or publish `session.json`, so a same-machine join does not
itself overwrite the control pointer. They do share execution storage when they share a home:

| State or resource | Current scope and consequence |
| --- | --- |
| `session.json` | One master control endpoint per home; different working directories do not select independent masters. |
| TCP listener | Default host plus port 7419, independent of home; normally select another port for each additional master on that host. |
| `session/worktrees/<basename>-I-N-eE` | Shared per home. Repo basename plus item ID/epoch is not a full checkout or session identity. Different clones with the same basename can collide, including peers of different masters sharing a default home. |
| `skep/session/I-N-eE` git branch | Per git repository, including linked worktrees. Item IDs restart in each master/session. Reusing a repo with retained work, or running independent workers on the same repo, can hit an existing branch even with separate homes. Materialization refuses to clobber it. |
| `session/transcripts/I-N-eE-<ms>-<view>.log` | Shared per home. Timestamps usually separate runs, but the filename contains no repo, peer, or session identity; simultaneous same-item/view runs can collide. Separate peer homes isolate these logs. |
| herdr agent `skep-iN-eE` | Shared through the local herdr service, outside the home namespace. Independent sessions can request the same name; changing `SKEP_HOME` does not solve this. Prefer PTY/native execution for concurrent independent sessions. |
| `device.toml` | Shared submit/notification configuration per home. An empty new home defaults session submit to `none` and has no configured notifier. |
| `keys/`, `allowed_signers`, `skepd.sock`, `skepd.lock`, `blackboard/`, `cli-blackboard/` | Other home-scoped state for the legacy signed-blackboard/daemon commands. Separate homes also separate these files; live session start/join does not allocate another daemon or clone. |

Master intents, peers, counters, and join codes live in memory; `session.json` is only a control
pointer, not a persisted session database. Provider configuration remains local to the agent
CLI and is not stored or distributed by Skep (ARCHITECTURE D19).

## Supported patterns today

| Pattern | Support in 0.1.8 |
| --- | --- |
| One master, peer in another checkout, same home | Supported for local discovery: `/join <current-code>` can use `session.json`; bare `/join` can obtain the local master's current code. Supply the intended `--repo` if checkout basenames differ. Shared worktree/branch limitations still apply. |
| One master, peers with separate `SKEP_HOME` or `--home` | Supported and recommended for concurrent peer work. Use the master's complete `/join --host ... --code ... --repo ...` line, because an isolated peer home cannot discover the master's pointer. |
| Peers on this machine joining a remote master | Supported with explicit `--host` and current code. Use a separate home for each concurrent worker to avoid shared local execution storage. |
| One master coordinating multiple logical repos | Supported by the CLI's `session intent ... --repo <name...>` and peer repo labels. Shell free text and `/intent` use the master's default repo; they do not infer the repo from another shell's cwd. |
| Two independent masters, default home and listener | Not supported. They conflict first on the live-master guard, or on the bind if their starts race. |
| Two independent masters, different ports only | Not supported in one home: sequential starts are refused; racing starts can replace the single pointer. |
| Two independent masters, separate homes only | Not sufficient when both choose the same default listen endpoint. |
| Two independent masters, separate homes and listen endpoints | Supported. Keep each control invocation on the right master home and each worker on its own home/checkouts. PTY/native avoids the separate herdr name limitation. |

Join codes are single-use and rotate, so each additional peer needs the master's current code.
A home override is a process-launch/global CLI option, not a `/start` or `/join` option.

## Workarounds users can use now

For two independent projects on the same machine, choose stable explicit homes and different
ports. These are terminal commands; the following slash command belongs inside each Skep shell:

```bash
# Terminal A, master for project A
cd /proj-a
skep --home "$HOME/.skep/sessions/proj-a/master"
```

```text
/start --listen 127.0.0.1:7419 --repo proj-a
```

```bash
# Terminal B, master for project B
cd /proj-b
skep --home "$HOME/.skep/sessions/proj-b/master"
```

```text
/start --listen 127.0.0.1:7420 --repo proj-b
```

The environment equivalent is
`SKEP_HOME="$HOME/.skep/sessions/proj-b/master" skep`. `--home` wins over that variable.
For noninteractive master control, retain the same override, for example:

```bash
skep --home "$HOME/.skep/sessions/proj-b/master" session status
skep --home "$HOME/.skep/sessions/proj-b/master" session intent "add a health check"
```

Each project also needs a worker. In another terminal opened in the appropriate checkout,
launch Skep with its own peer home, such as
`skep --home "$HOME/.skep/sessions/proj-b/peer-1"`, then paste B's complete join line:

```text
/join --host 127.0.0.1:7420 --code <current-code-from-B> --repo proj-b
```

For one master with peers in other directories, keep one master and use that same join pattern;
there is no need to `/start` in every peer terminal. Omitting `--host` works only when the peer's
selected home contains the intended master's pointer. Loopback examples are for this machine;
use a reachable concrete interface and the advertised join address for remote peers.

Use separate clones when concurrent work would reuse the same git repository and item branch.
For saved work from an earlier session, submit or preserve it before removing the conflicting
branch/worktree; `/clean` does not dispose of it. Use PTY/native instead of a shared herdr
service when independent sessions might request identical agent names. Configure submit and
notification preferences in each chosen home if the defaults are unsuitable.

## Recommended fix and implementation decision

Evaluate the candidate defaults before changing discovery:

* **Namespace the entire default home by repo basename/cwd.** This would separate control and
  worker storage, but basenames collide and subdirectories/symlinks need canonical git-root
  handling. It also changes device configuration/trust locations and breaks today's automatic
  local-master discovery from another checkout. The fixed default port still conflicts.
* **Namespace only session state or allow multiple repo-indexed masters.** This preserves
  device configuration, but requires a registry/selection rule for status, intent, join, and
  cleanup, migration of the old pointer, safe publication, port allocation, and worker/session
  identities. That is a coordinated design change rather than a small local path edit.
* **Explain home and listen isolation at the failure.** Both overrides already exist and allow
  independent masters without changing single-session discovery. This is the smallest useful
  fix and is explicitly one of the task brief's options.

Implemented the third option in the shared `startMasterFlow` path, so it applies to both
`/start` and `skep session start`:

* `session_running` now explains that project directories share one session per home, and
  gives both the shell-launch-plus-`/start` workaround and the terminal CLI equivalent.
* A `ListenAddressError` caused by `EADDRINUSE` becomes `session_port_in_use`, naming the
  attempted endpoint and explaining `--listen` plus separate homes. Other bind errors retain
  their original behavior.

This is an error-guidance fix, not automatic multi-project isolation. Default-home starts
remain single-session; no registry, wire protocol, persisted-file schema, or version changed.
Any future automatic isolation should namespace stable checkout/session/peer identities,
allocate ports, and address herdr/branch collisions together while preserving explicit
same-machine joins. The current explicit setup remains usable without that redesign.

## Validation

Regression tests in `src/cli/commands/session.test.ts` cover a second project's rejection
with and without another port, retention of the first pointer, a real TCP bind collision after
a `--home` override, preservation of other bind failures, and two concurrent real masters
with separate control files and independent status/cleanup. The concurrent-master test
injects ephemeral loopback ports and also checks the original requested listener options.
`src/cli/shell/run.test.ts` covers the same home/port advice in `/start`, keeping the displayed
external master after rejection and leaving no session after a bind failure.

Results in this worktree on 2026-10-12:

* `npm run lint`: **passed**, including TypeScript checks for the added tests.
* `npm run build`: **passed**.
* The exact four-file focused command from the brief was attempted, then interrupted because
  this sandbox rejects loopback listeners. A standalone Node listener also fails with
  `listen EPERM: operation not permitted 127.0.0.1`.
* Repeating those four files with `--testTimeout 1000 --hookTimeout 1000` completed with
  **123 passed, 52 failed, and 30 unhandled errors**. Socket fixture creation raises `EPERM`;
  fixtures that wait only for a successful listen time out. Real-session tests fail with a
  `ListenAddressError` whose cause is the same `EPERM`. This is not a green focused gate.
  The output is retained in the ignored `.skep-sim/multi-proj-focused.log`.
* A filtered run of the three relevant files selecting `skepHome`, `skepPaths`, the preserved
  non-collision bind error, and the shell's simulated port-collision advice **passed all seven
  selected tests** (149 excluded by the name filter). This validates the paths and the error
  translation that can execute without a listener, not the real-socket regressions.
* The full `npm test` run is pending: the brief gates it on passing focused tests and lint,
  and the focused gate is blocked here. Run the exact focused command, lint, and then the
  full suite in an environment that permits loopback listeners before committing.

The initial `npm ci` hit a sandbox `EPERM` during esbuild's post-install subprocess. An offline
install from a copy of the existing npm cache inside ignored repository scratch storage, with
lifecycle scripts skipped, succeeded; Vitest, lint, and the build all execute. No dependency or
package version changed. Changes remain uncommitted as required by the task brief.

## Implemented automatic isolation (PROJ-ISOL)

The diagnosis above records 0.1.8 and the earlier MULTI-PROJ guidance. The new defaults isolate
projects automatically; the explicit setup above remains supported.

### Chosen design

* Resolve the project root from the invocation's cwd: use the realpath of
  `git rev-parse --show-toplevel` inside a work tree, otherwise the realpath of cwd. Hash the
  absolute root string with SHA-256 and use its first 12 hexadecimal characters as the project
  ID. Subdirectories and symlink aliases of one checkout share an ID; separate checkouts with
  the same basename have different IDs. Linked Git worktrees have their own toplevel and ID.
* Resolve home in order: CLI `--home`, nonempty `SKEP_HOME`, then
  `~/.skep/projects/<projectId>`. Overrides remain exact, without additional nesting. The CLI
  passes its cwd explicitly to path resolution. All existing `skepPaths(home)` state follows
  that home, including `session.json`, `session/worktrees`, `session/transcripts`, and
  `device.toml`; a fresh project's submit policy therefore defaults to `none`.
* Without `--listen`, try port 7419 on the existing selected LAN IPv4 interface, then scan
  7420–7519 on that same interface only after an address-in-use error. Bind directly on each
  attempt rather than checking availability first. Stop after 101 attempts; report exhausted
  ports with advice to select an unused `--listen` address. Other bind failures surface
  immediately. An explicit `--listen` gets one attempt and is never rewritten.
* Publish the actual bound endpoint in the project's pointer. Advertise that endpoint and
  print it in the full `/join --host ... --code ... --repo ...` line unless `--advertise`
  explicitly overrides it. Repo routing remains basename / `--repo`, independent of the ID.
* Keep the live-master guard and token-owned pointer cleanup per home. A second sequential
  start in the same project is refused. If explicit home overrides make unrelated projects
  share a home, the same guard applies; the error explains the override and automatic defaults.

### Discovery and migration

Two terminals in the same canonical project root select the same default home: bare `/join`,
status, intent, and `/clean` discover that project's master as before. A peer in a different
checkout selects a different home and must paste the master's full join line. A different
project's `/clean` or status does not affect or discover the first project's pointer.

The legacy global `~/.skep/session.json` is **not auto-migrated** or discovered by the new
default. To retain the former shared home, launch with `SKEP_HOME="$HOME/.skep"` or
`skep --home "$HOME/.skep"`. Existing global `device.toml`, trust, and key files are not copied;
configure each project home or use the explicit legacy home. Opening a shell fixes its context;
changing directory afterward still does not switch sessions.

This change does not add a master registry, session history, or protocol changes. Starts racing
in one home still have the pointer publication limitations described above. Git branch names
remain repository-scoped, and herdr agent names remain shared outside the home namespace;
independent sessions can still collide there. PTY/native execution and separate clones remain
the relevant workarounds; broader worker identity isolation is a follow-up.

### Acceptance coverage and validation

| Criterion | Regression coverage |
| --- | --- |
| 1. Different default homes | `paths.test.ts` checks different roots with identical basenames under one temporary user home. |
| 2. Stable same-project home | `paths.test.ts` checks repeated resolution, Git subdirectories, and symlink aliases; `session.test.ts` checks peer pointer discovery in the same Git root. |
| 3. Exact overrides | `paths.test.ts` checks absolute and relative `SKEP_HOME`; `program.test.ts` checks `--home` over env before opening the shell. Existing concurrent override coverage remains. |
| 4. Git root over cwd | `paths.test.ts` resolves a nested cwd to the canonical toplevel and ignores unrelated Git environment overrides. Non-Git and bare-repo fallbacks are covered. |
| 5. Automatic busy-port retry | `session.test.ts` injects busy ports, checks bounded exhaustion, pointer publication, advertise overrides, and rotated paste lines. An additional real bind test injects occupied and ephemeral loopback targets; `run.test.ts` checks `/start` and its paste line. |
| 6. Explicit busy port | `session.test.ts` checks exactly one attempted bind and retains the real occupied-port error test; `run.test.ts` checks shell guidance. |
| 7. Same-home live guard | Existing shared-home control/shell tests retain pointer preservation. A new default-home real-master test also checks refusal before a second bind. |
| 8. Concurrent project homes | A socket-free test starts two default project homes, checks separate pointers and same-root discovery, and closes each independently. Real ephemeral-master coverage checks scoped status, guards, and cleanup, including no discovery from another project. |
| 9. Join, submit-none, clean | Existing regressions remain. New bare `/join` tests cover own and external masters in a default project home; the own-master test checks submit `none` and `/clean`, and a shell retry test checks cleanup after automatic port selection. |

Validation for PROJ-ISOL in this sandbox on 2026-10-12:

* `npm run lint` and `npm run build`: **passed**. Package version remains 0.1.8; no dependency
  or configuration files changed.
* A selection of all path/program tests and socket-free retry, exhaustion, default-project
  discovery, own-master bare join, and cleanup regressions: **27 passed** (152 excluded by the
  name filter).
* The exact four-file focused run was attempted with its normal timeouts, then stopped after
  60 seconds because listener fixtures cannot complete here. A standalone loopback bind
  reproduces `listen EPERM: operation not permitted 127.0.0.1`.
* The focused run with `--testTimeout 1000 --hookTimeout 1000` completed: **137 passed,
  55 failed, 32 unhandled errors**. Real-listener regressions are blocked by the same `EPERM`,
  with fixtures that wait for listening timing out.
* The full `npm test -- --testTimeout 1000 --hookTimeout 1000` run completed: **570 passed,
  79 failed, 32 unhandled errors** across 31 files. In addition to listener failures, seven
  unchanged `src/util/exec.test.ts` cases receive empty stdout/stderr from child Node processes.
  A standalone `execFile("node", ..., { shell: false, env: {} })` reproduces the empty output
  despite exit code 0. These results are not a green focused or full gate.

Logs are retained in ignored `.skep-sim/project-isolation-focused.log`,
`.skep-sim/project-isolation-focused-bounded.log`, and `.skep-sim/project-isolation-full.log`.
Re-run the normal focused command and full suite outside the sandbox before committing.
Changes remain uncommitted, as required by PROJ-ISOL.
