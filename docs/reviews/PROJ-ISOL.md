# Review: PROJ-ISOL — per-project automatic session isolation

* Branch: `feat/project-session-isolation` (worktree `<worktree>`), commit `03155c9`
* Base: `main` (MULTI-PROJ tip `373740f` / `e972f4b`)
* Spec: PROJ-ISOL task brief + extended `docs/plans/multi-project-same-machine.md`

## Verdict

Verdict: **PASS_WITH_NOTES**.  every acceptance criterion is met and covered by tests. Focused tests, the
full suite, and lint are green, and the branch merges cleanly. The notes cover a stale
validation section in the plan doc, the per-project key/trust migration consequence, and minor
robustness details. None of them blocks merging.

## Test results (run in `<worktree>`)

| Command | Result |
| --- | --- |
| `npx vitest run src/config/paths.test.ts src/cli/program.test.ts src/cli/commands/session.test.ts src/cli/commands/session.control.test.ts src/cli/shell/run.test.ts` | 5 files, **198 passed**, 0 failed |
| `npm run lint` (biome + `tsc --noEmit`) | **passed** (82 files, no fixes) |
| `npm test` (full) | 31 files, **649 passed**, 0 failed (matches the orchestrator's run) |

## Merge check

`git merge-tree --write-tree main feat/project-session-isolation` → exit 0, tree
`33834f6…`, no conflicts.

## Scope check

Changed files: `CHANGELOG.md`, `docs/plans/multi-project-same-machine.md`,
`src/config/paths.ts` (+test), `src/cli/program.ts` (+test), `src/cli/commands/session.ts`
(+test), `src/cli/shell/run.ts` (+test). All of these are in the brief's expected touch set.
`package.json`, configs, and dependencies are unchanged, and the version stays `0.1.8`. The
CHANGELOG changes are confined to `[Unreleased]`. No out-of-scope features were added.

## Acceptance checklist

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Default home `~/.skep/projects/<12-hex>` from git toplevel, else cwd realpath | ✅ | `resolveProjectRoot` realpaths cwd and runs `git rev-parse --show-toplevel` (`execFile`, no shell). On success it realpaths the result. On "not a git repository" / "must be run in a work tree" it falls back to the canonical cwd. `projectId` = sha256 hex truncated to 12 chars. Tests: "prefers the Git toplevel over a nested cwd" and "uses cwd outside a Git work tree, including a bare repository". |
| 1a | Same root ⇒ same home; different roots ⇒ different homes | ✅ | "ignores an empty SKEP_HOME and selects a stable project home" (repeated runs, subdirectory, symlink alias). "isolates different roots even when their basenames match". |
| 1b | Git env overrides cannot redirect project choice | ✅ | The git child env is reduced to `PATH`/`HOME`/`LC_ALL`. Test: "ignores Git environment overrides when choosing the cwd's project". |
| 2 | `--home` / `SKEP_HOME` win exactly, with no nesting | ✅ | `skepHome` returns a non-empty `SKEP_HOME` before resolving the project. `applyGlobals` maps `--home` → `SKEP_HOME`. Tests: "honours SKEP_HOME exactly without resolving the project or nesting" and program "--home overrides SKEP_HOME exactly before opening the shell". |
| 3 | Auto port retry 7419–7519 when `--listen` unset | ✅ | `bindMaster` binds directly on each port, with no pre-probe race. It retries only on `ListenAddressError` with cause `EADDRINUSE`, up to `LAST_AUTO_PORT = 7519` (101 attempts), and exhaustion gives `session_port_in_use`. Tests: "bounds automatic port retries and never publishes a pointer on exhaustion" and "retries an actual bind collision using injected ephemeral loopback targets". |
| 3a | Explicit busy `--listen` ⇒ error, no rewrite | ✅ | `lastPort = target.port` when `--listen` is given, so there is a single attempt. Test: "never retries an explicit busy listen address" (asserts exactly one bind) plus the existing real occupied-port test. |
| 4 | Pasteable `/join` uses the actual bound/advertise port | ✅ | `listen = listenOf(handle)` (the bound endpoint) is written to `session.json` and used as `advertise` unless `--advertise` is set. Tests: `it.each([undefined, "203.0.113.7:8500"])` checks the paste line after rotation to `DEFAULT_PORT + 2`, and run.test "/start auto-picks a free port for the paste line and /clean removes its pointer". |
| 5 | Same-project local `session.json` discovery preserved; cross-project isolation intentional | ✅ | "isolates concurrent default project homes and shares same-root discovery" and "scopes real master status, live guards, and cleanup to default project homes" (a peer in another project does not discover the pointer; `/clean` is scoped). The same-home live guard is unchanged (`refuseIfRunning`). |
| 6 | No version bump / no publish | ✅ | `package.json` still says `0.1.8`. Single commit, nothing tagged or pushed. |
| 6a | D19: no credentials, real IPs, hostnames or emails | ✅ | The diff contains only documentation/private placeholder addresses (`203.0.113.x` TEST-NET-3, `192.168.1.20`, loopback), consistent with existing tests. No tokens, emails or host paths were found. |
| 7 | Messaging updated from "requires manual `--home` + `--listen`" | ✅ | `refuseIfRunning` and `session_port_in_use` text now describe automatic defaults and give override advice for real collisions. `/start` help line and `--listen` help were updated. |

## Findings

### Blocking

None.

### Non-blocking

1. **Stale validation section in the plan doc.** "Acceptance coverage and validation" in
   `docs/plans/multi-project-same-machine.md` still records sandbox-only results ("137 passed,
   55 failed…", "These results are not a green focused or full gate", "Changes remain
   uncommitted"). It also cites ignored `.skep-sim/*.log` files. The tree is now committed and
   green: 198 focused tests and 649 total pass outside the sandbox. A reader could take the
   branch as red. That paragraph should be replaced with the real results.
2. **Migration affects identity, not just the session pointer.** Every default project home
   gets its own `device.toml`, keys, and trust store, which the doc acknowledges. In practice,
   upgrading users get a new device identity per project, and peers must re-accept that device.
   The default submit policy also resets to `none`. The CHANGELOG mentions only the session
   home and `SKEP_HOME="$HOME/.skep"`. It should say explicitly that identity and trust are per
   project now. The optional brief hint about a live legacy `~/.skep/session.json` was not
   implemented. That hint is optional, but it would help upgraders who expect bare `/join` to
   find an old master.
3. **Every CLI action now spawns `git`.** The `preAction` hook resolves the project root (one
   `git rev-parse`) for every subcommand without an override, including ones that never touch
   session state. This is cheap but fails hard. If `git` is missing (ENOENT), or the repo
   triggers git's "dubious ownership" refusal (exit 128 with a different message), the command
   fails with `ProjectRootError`, even for non-session commands. The message is actionable
   (set `SKEP_HOME` / `--home`), so this is acceptable. Possible future improvements: resolve
   lazily, or fall back to the cwd realpath on spawn errors.
4. **Reduced git env.** Only `PATH`/`HOME` pass through, so `XDG_CONFIG_HOME`-located git config
   (for example a `safe.directory` entry) is not seen. Edge case only, and it relates to item 3.
5. **Same-home start race unchanged.** As documented, concurrent starts within one home still
   have the pre-existing pointer-publication race. Automatic ports make it easier to get two
   bound masters there (the second no longer fails on 7419), but the `refuseIfRunning` guard
   still covers the normal sequential case. This is out of scope and noted in the doc.

## Follow-ups

* Refresh the plan doc's validation section with the real green results and drop the
  sandbox-only notes and log references.
* Add a CHANGELOG/docs line about per-project device identity, trust, and `device.toml` after
  the upgrade. Consider the optional one-line legacy-pointer hint on `/start` / bare `/join`.
* Consider lazy project-root resolution, or a cwd fallback when `git` cannot be spawned.
* Known, already-documented follow-ups: herdr agent naming and git branch name collisions
  across independent sessions in one repository; multi-master registry.
