# Skep release record

This document records the package-name decision (v0.1.0), the npm registry re-check, the
v0.1.0 checklist, the v0.1.1 session-TUI notes, the v0.1.5 peer-progress and TUI notes, and the
steps the orchestrator runs. Task agents must not `git push`, create tags, or `npm publish`.

## v0.1.7 — TUI/session reliability (2026-10-10)

The human ordered this release as **0.1.7**. Package name stays **`@skepagent/skep`**
(public). The only bin is `skep`.

What this tag adds on top of v0.1.6 (details in [`../CHANGELOG.md`](../CHANGELOG.md)):

* **Single session truth** in the unified shell (`SessionController`): header, peers, slash
  gating and intents share one snapshot. External masters are bound by identity.
* **`/join` ergonomics**: `/join <host:port> <code>` (either order) and the existing flagged
  forms; clearer usage errors.
* **Intent UX**: refuse when no peers joined; descriptive `no_match`; lost-reply reported as
  may-have-been-accepted (no unsafe “resend” claim).
* **Presence**: named peer leave reasons, heartbeat/quiet ages in the bee footer.

Compatibility: upgrade both devices. Wire protocol is additive (presence display only).

Install:

```bash
npm install -g @skepagent/skep@0.1.7
```

---


## v0.1.5 — peer progress and the redesigned session screen (2026-10-09)

The human ordered this release as **0.1.5**. Versions 0.1.3 and 0.1.4 are skipped and were
never tagged. Package name stays **`@skepagent/skep`** (public, `publishConfig.access`
`"public"`). The only bin is `skep`. `files` stays `dist`, `README.md`, `LICENSE`,
`CHANGELOG.md`.

What this tag adds on top of v0.1.2 (details in [`../CHANGELOG.md`](../CHANGELOG.md)):

* **Peer progress**: a new opt-in `progress` session message. The master derives every peer's
  phase and `done/total` and relays them, rate-limited. `skep ui` and `skep session join --ui`
  draw one strip per peer: an animated Nerd Font bee (ASCII fallback), an eight-cell bar, the
  percentage, the phase and the item title.
* **Redesigned session screen**: a one-line header with the version, `PEERS` / `ITEM` /
  `OUTPUT` rules, aligned columns, state chips colored by phase, a footer that shows only
  the keys that act now, and calmer empty states. Inverse marks only the selected row.
* **Theme and environment**: `SKEP_TUI_COLOR`, `SKEP_TUI_THEME`, `SKEP_TUI_ANIMATE`, plus
  `NO_COLOR` and `FORCE_COLOR`. `SKEP_TUI_GLYPHS` / `SKEP_TUI_ASCII` are unchanged.
* `skep -V` prints `0.1.5`, read from `src/cli/version.ts`, which is kept in step with
  `package.json`.

Compatibility: upgrade the **master device first**. A 0.1.5 sub cannot join a 0.1.2 master,
because the old master rejects the unknown `progress` frame. A 0.1.2 sub can join a 0.1.5
master.

Orchestrator, after `feat/tui-material-0.1.5` merges into `main`:

1. Confirm `node -e "console.log(require('./package.json').name, require('./package.json').version)"`
   prints `@skepagent/skep 0.1.5`, and `node dist/bin/skep.js -V` prints `0.1.5` after the
   build.
2. `npm ci && npm run lint && npm test && npm run build`. Any pre-existing failures must be the
   ones listed in the merge commit and be accepted by the human. Check that
   `npm pack --dry-run` lists only `dist/**`, `README.md`, `LICENSE`, `CHANGELOG.md` and
   `package.json`.
3. Manual QA from the TUI plan (`docs/plans/tui-material-redesign.md` §6.5). Use two
   devices or directories, each running `session join --ui`, plus `skep ui`. Repeat with
   `NO_COLOR=1`, `SKEP_TUI_THEME=light`, `SKEP_TUI_GLYPHS=ascii`, and at 80×24.
4. Create the annotated tag `v0.1.5` on the merge commit and push it:

   ```bash
   git tag -a v0.1.5 <merge-commit-sha> -m "v0.1.5"
   git push origin v0.1.5
   ```

5. **The orchestrator may publish this release**, because the human has ordered 0.1.5. This
   needs a logged-in npm account with publish rights on the `skepagent` org:

   ```bash
   npm publish --access public
   npm view @skepagent/skep@0.1.5 version   # expect 0.1.5
   ```

Install from git until the publish has happened:

```bash
npm install -g github:Guxiaodong941005/skepAgent#v0.1.5
```

---

## v0.1.1 — session TUI (2026-10-09)

Patch on the v0.1.0 blackboard. Package name stays **`@skepagent/skep`** (public). Bins stay
`skep` and `skepd`. `publishConfig.access` stays `"public"`. `files` stays `dist`, `README.md`,
`LICENSE`, `CHANGELOG.md`.

Product UX for this tag:

* Bare `skep` (no subcommand) opens the locally installed agent CLI (claude, then codex, then
  pi). `skep tui` is the same entry. The agent keeps its own TUI.
* `skep ui` and `skep session join --ui` open the Skep session screen: peers, current item,
  agent state, redacted output tail, submit choice (D30). One agent occupies the terminal.
* Session protocol: `skep session start|join|intent|status`. Subs work items and apply this
  device's submit policy (`ask` / `pr` / `mr` / `push` / `none`).
* Live view: PTY, else optional local herdr, else the native non-interactive CLI (D27–D29).
  Full transcripts stay on the executing device. No provider credentials are transported (D19).

`REDUCER_VERSION` and `protocol_version` stay 1. `skep -V` still prints the scaffold string
`0.0.1`.

SK-609 remains waived (no `docs/MVP-RUN-REPORT.md`). Wave 7 is not in this tag. `npm publish`
stays deferred until the human creates org `skepagent` and says go.

Install until then:

```bash
npm install -g github:Guxiaodong941005/skepAgent#v0.1.1
```

Orchestrator, after this branch merges (do **not** push, tag, or publish from the task agent):

1. Confirm `node -e "console.log(require('./package.json').name, require('./package.json').version)"`
   prints `@skepagent/skep 0.1.1`.
2. `npm run lint && npm test && npm run build` green. `npm pack --dry-run` lists `dist/**`,
   `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json` only (no `src/`, `test/`, fixtures, keys).
3. Annotated tag `v0.1.1` on the merge commit, pushed only on explicit human go:

   ```bash
   git tag -a v0.1.1 <merge-commit-sha> -m "v0.1.1"
   # git push origin v0.1.1    # only on explicit human go
   ```

4. **Do not run `npm publish`.**

---

## v0.1.0 — first public tag

Tag-only first public release of the MVP. The sections below are the v0.1.0 record and are kept
as history. v0.1.1 **does** merge `task/session-mode`; the "do not merge session-mode" line
applies only to the 0.1.0 tag.

Normative product scope: [`PRD-v0.4.md`](PRD-v0.4.md) §16. Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md).
Operating procedures: [`RUNBOOK.md`](RUNBOOK.md). Changelog: [`../CHANGELOG.md`](../CHANGELOG.md).

## Package name

**Decision (human, 2026-10-09): `@skepagent/skep` (scoped, public).** Bin names stay `skep` and
`skepd`. `skepd` is not a separate package.

Criteria from [`DEV-PLAN.md`](DEV-PLAN.md) SK-610, applied in order:

1. Unscoped `skep` is **not** available. Do not try to reclaim or name-squat it.
2. Preferred: scoped `@skepagent/skep` after the human creates the `skepagent` npm org, published
   with `--access public`.
3. Fallback `skep-agent` was not needed.
4. Final choice is this human decision.

### npm view re-check (2026-10-09, read-only)

Commands run from the SK-610 worktree against the public npm registry. No publish.

| Command | Result |
|---|---|
| `npm view skep name version` | **taken** — `name = 'skep'`, `version = '0.0.2'` (unrelated package; last modified 2022 per the 2026-10-06 snapshot) |
| `npm view skepd name` | **404** Not Found |
| `npm view @skepagent/skep name` | **404** Not Found (free) |
| `npm view skep-agent name` | **404** Not Found (free; unused fallback) |
| `npm view skepagent name` | **404** Not Found |
| `npm access list packages @skepagent` | exit 0, empty listing — the org is not owned in this environment and likely does not exist yet (org page was 404 on 2026-10-06) |

`npm search skep` look-alikes (unrelated, not ours): `skep` 0.0.2; `@skeptools/*`;
`@datyuba/skep`; `@syntropy-systems/skep`. None is this project.

**Publish is deferred.** Creating the npm org `skepagent` (and ideally the matching GitHub org)
is a human step. This tag does not run `npm publish`. `package.json` already has
`publishConfig.access: "public"` so a later public publish of the scoped name does not need a
manifest change.

Install until then:

```bash
npm install -g github:Guxiaodong941005/skepAgent#v0.1.0
# or: clone the tag, npm ci && npm run build, put dist/bin on PATH
```

## Versioning

SemVer 0.x. `0.1.0` is the first public tag. While 0.x, a minor bump may break CLI flags, config
or the blackboard protocol; a patch bump may not. A protocol or reducer change follows
ARCHITECTURE §4.4 (`REDUCER_VERSION` golden evidence + human re-genesis of a live blackboard).

This tag: `package.json` version `0.1.0`, `REDUCER_VERSION` 1, `protocol_version` 1. `skep -V`
still prints the SK-104 scaffold string `0.0.1` (known limitation).

## Pre-release checklist

Status values: **pass** / **fail** / **waived**. Binding verify commands for this task are
`npm run lint && npm test && npm run build`, `npm pack --dry-run`, and the package name/version
print. Broader DEV-PLAN items are recorded honestly.

| # | Item | Outcome |
|---|---|---|
| 1 | SK-609 passed: PRD §16.5 on a real two-device run, `docs/MVP-RUN-REPORT.md`, no open blocking gap | **waived by user** for v0.1.0 on 2026-10-09. Reason: the user explicitly waived SK-609 for this tag. SK-609 remains `todo`. No `MVP-RUN-REPORT.md`. |
| 2a | `npm ci && npm run lint && npm test && npm run build` green on this release commit | **pass** on the SK-610 worktree (`task/SK-610-release`). `npm ci` was done before the task started. |
| 2b | `SKEP_PROPERTY_LOGS=1000` | **fail** (not run for this tag). |
| 2c | Sim scenarios at 50 seeds (`SKEP_SIM_SEEDS=50 npx vitest run test/integration/sim`, G1) | **fail** (not run for this tag; `npm test` keeps the 3-seed default and is green). |
| 2d | Opt-in real-adapter tests on a device with the pinned CLI | **fail** (not run; no `SKEP_REAL_CODEX=1` in this environment). |
| 3 | Secret scan clean: `gitleaks detect` over full git history and over the `npm pack` tarball; only allowlisted findings are the documented test keys | **pass with notes** (recorded for the 0.1.0 tag, when `task/session-mode` was not merged). `.gitleaks.toml` allowlists `test/fixtures/keys/`. Full-history `gitleaks detect` still reports (G18) a dummy `ssh-ed25519` body in `src/git/trust.test.ts`. Pack tarball does not include `src/` or `test/`. v0.1.1 merges session-mode; re-scan that tree before its tag. |
| 4 | No absolute host paths, real hostnames, IPs or personal emails in the repo | **pass.** Grep on 2026-10-09 found no public IPv4 and no personal emails. Remaining hosts are examples (`example.invalid`, `github.com` in fixtures/PRD, `skepagent.com`). |
| 5 | D19 non-goal in README, ARCHITECTURE (top + §16) and the release notes; D18 "no inbound connectivity" in README | **pass** (this change set). |
| 6 | All DEV-PLAN MVP tasks `done` with reviews in `docs/reviews/`; Wave 2b/3 follow-ups F1–F21 closed or deferred in CHANGELOG known limitations | **pass with notes.** SK-101..SK-608 and SK-611..SK-614 are `done` with reviews. SK-609 remains `todo` (waived for this tag). F21 (relay) stays with SK-701 / Wave 7 and is listed as a known limitation. Wave 8 session-mode/TUI is not included. |
| 7 | `REDUCER_VERSION` / `protocol_version` match the golden fixtures; ARCHITECTURE §15 is current | **pass.** Both are 1; goldens under `test/fixtures/golden/` replay against that pair. |
| 8 | LICENSE present; `package.json` fields; `npm pack --dry-run` reviewed; name decision recorded | **pass.** MIT LICENSE; name `@skepagent/skep`, version `0.1.0`, `files` limited to `dist`, README, LICENSE, CHANGELOG; pack list has no `src/`, `test/`, fixtures or keys. |
| 9 | Human sign-off on the tag and the publish command | **waived in part.** This task prepares the tag commit only. The orchestrator creates annotated tag `v0.1.0` after merge; **do not `npm publish`** until the human creates org `skepagent` and says go. |

## Known limitations carried into the tag

Recorded in [`CHANGELOG.md`](../CHANGELOG.md) as well:

* SK-609 two-device acceptance **waived by user** for v0.1.0 (2026-10-09).
* No `npm publish`; org `skepagent` may not exist yet.
* Codex adapter only; macOS/Linux; single slot per device.
* Wave 7 relay / enrollment not required and not shipped.
* Wave 8 session-mode / TUI **not merged** into the 0.1.0 tag (`task/session-mode` stayed off
  `main`; it lands in 0.1.1).
* G2: moving an item to another agent = revoke + human-approved replan.
* G4: sim fixture keys live under `test/` and are not in the npm pack.
* G18: gitleaks dummy-key false positive in `src/git/trust.test.ts`.
* `skep -V` still prints `0.0.1`.

D19 (verbatim) and D18 (no inbound connectivity / no mesh VPN required) are restated in the
README "What Skep never does" box.

## What this tag contains

MVP from current `main` lineage only:

* Signed git blackboard, deterministic reducer, epoch-fenced leases.
* Daemon tick / slots / duties, CLI, Codex adapter, stacked delivery.
* Wave 6b: SK-611, SK-612, SK-613, SK-614.
* D18 outbound-only networking; D19 no credential transport.

Not in the 0.1.0 tag: SK-609 evidence, Wave 7 (SK-701..SK-703), Wave 8 session/TUI (shipped in
0.1.1), npm registry package.

## Orchestrator: commit, tag, do not publish

The SK-610 agent commits on `task/SK-610-release` and **does not** push, tag, or publish.

After review, the orchestrator:

1. Merge `task/SK-610-release` to `main` (do **not** merge `task/session-mode` or any Wave 8
   worktree).
2. Confirm on the merge commit:
   * `node -e "console.log(require('./package.json').name, require('./package.json').version)"`
     prints `@skepagent/skep 0.1.0`
   * `npm pack --dry-run` file list is `dist/**`, `README.md`, `LICENSE`, `CHANGELOG.md`,
     `package.json` only
   * `npm run lint && npm test && npm run build` still green
3. Create an **annotated** tag on that commit, then push the tag only when the human says go:

   ```bash
   git tag -a v0.1.0 <merge-commit-sha> -m "v0.1.0"
   # git push origin v0.1.0    # only on explicit human go
   ```

4. GitHub release notes for `v0.1.0` can summarise CHANGELOG.md. There is no
   `docs/MVP-RUN-REPORT.md` and no `npm pack` checksum in this record because publish is
   deferred.
5. **Do not run `npm publish`.** Wait until the human has created npm org `skepagent` and
   explicitly says go. Then, from a clean checkout of `v0.1.0`:

   ```bash
   npm ci && npm run check && npm run build
   npm publish --access public
   ```

   The `prepublishOnly` script already runs `npm run check && npm run build`.
