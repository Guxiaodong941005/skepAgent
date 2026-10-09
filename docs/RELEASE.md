# Skep v0.1.0 release record

Tag-only first public release of the MVP. This document records the package-name decision, the
npm registry re-check, the pre-release checklist, and the steps the orchestrator runs. Agents
must not `git push`, create tags, or `npm publish`.

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
| 3 | Secret scan clean: `gitleaks detect` over full git history and over the `npm pack` tarball; only allowlisted findings are the documented test keys | **pass with notes.** `.gitleaks.toml` allowlists `test/fixtures/keys/`. Full-history `gitleaks detect` still reports (G18) a dummy `ssh-ed25519` body in `src/git/trust.test.ts`, plus historical session-mode test tokens that are **not** in this tree (`task/session-mode` was not merged). Pack tarball does not include `src/` or `test/`. |
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
* Wave 8 session-mode / TUI **not merged** (`task/session-mode` stayed off `main`).
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

Not in this tag: SK-609 evidence, Wave 7 (SK-701..SK-703), Wave 8 session/TUI, npm registry
package.

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
