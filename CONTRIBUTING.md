# Contributing to Skep

Thanks for your interest in Skep! The project is an early MVP, so the most useful contributions
right now are the tasks in [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md), bug reports, and review of the
protocol design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/PRD-v0.4.md`](docs/PRD-v0.4.md). When the documents disagree, the PRD is normative.

## Development setup

Requirements: Node.js ≥ 22.12 with npm, `git` ≥ 2.34, and OpenSSH `ssh-keygen`.

```bash
git clone https://github.com/<org>/skep.git
cd skep
npm ci                       # first thing in a fresh clone or worktree
npx vitest run <path>        # focused tests while working
npm test                     # full test suite
npm run lint                 # Biome check + tsc --noEmit
npm run fix                  # auto-fix formatting and import order
npm run build                # emit dist/ (sanity check)
npm run skep -- --help       # run the CLI from source
```

Tests must not touch `~/.skep` or the real network. Use temp directories (`SKEP_HOME`), local bare
repositories and fake adapters. Tests that need a real agent CLI run only behind an opt-in
environment variable (for example `SKEP_REAL_CODEX=1`).

## Picking up a task

Work is organized in waves in [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md). Tasks in the same wave touch
disjoint files and depend only on earlier waves, so they can be built in parallel.

1. Pick a task with status `todo` whose dependencies are `done`. Comment on the matching issue (or
   open one) so nobody duplicates the work.
2. Read the task row, its brief if there is one, and the ARCHITECTURE sections it references.
3. **Stay inside the task's files.** Only create or modify the files listed for the task, plus
   colocated `*.test.ts` files and test helpers you own. Do not change shared contracts in
   `src/core/**` unless the task owns them, and do not change `package.json` or tool configs. If a
   contract looks wrong, implement against it and explain the problem in your PR.
4. No new dependencies unless the task says so.
5. Map every acceptance criterion to at least one test.

Changes outside the plan (bug fixes, docs, design proposals) are welcome too. For anything that
changes the protocol, open an issue to discuss it first.

## Branches and commits

* Branch from `main` as `task/<ID>-<short-slug>` (for example `task/SK-201-lease-handlers`), or
  `fix/<slug>` / `docs/<slug>` for work outside the plan.
* Use [Conventional Commits](https://www.conventionalcommits.org/): imperative mood, subject of at
  most 72 characters, task ID in the subject when there is one.

  ```text
  feat(reducer): implement lease and delivery handlers (SK-201)

  What changed and why, notable decisions, anything left for later.
  ```

  Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.
* Small, focused commits are fine; the last commit of a PR must leave the tree green.
* Write all text in English: code, comments, docs, commit messages.

## Required checks

Before opening a pull request, both of these must pass:

```bash
npm run lint
npm test
```

PRs that fail them are not reviewed until they are fixed.

## Coding rules

The full list is in [`AGENTS.md`](AGENTS.md). The most important ones:

* **TypeScript strict, ESM.** Relative imports end in `.js`; use `import type` for type-only
  imports. Formatting is Biome's (run `npm run fix`).
* **`src/core/**` is pure.** No `fs`, `child_process`, network, `Date.now()`, `Math.random()` or
  `process.env`. Everything else receives its I/O dependencies (git runner, clock, random source,
  runtime backend, code host) as parameters so the simulator can inject fakes.
* **No ambient time or randomness.** Use the injected `Clock` and `RandomSource`, never
  `Date.now()`, `performance.now()`, `setTimeout` for protocol timing, or `Math.random()`.
* **No shell execution.** Spawn subprocesses with `execFile`/`spawn` and `shell: false`. Never build
  shell command strings.
* **Validate every external input** (files, model output, socket frames) with the strict Zod
  schemas in `src/core/schemas`. Protocol objects reject unknown keys.
* **Reducer state is plain, deterministic JSON:** no `Map`, `Set`, `Date` or `undefined`.
* **Errors are typed** `Error` subclasses with actionable messages. No silent catches.
* **Comments explain why**, and cite PRD or ARCHITECTURE sections for protocol rules.

## AI-assisted contributions

AI-assisted contributions are welcome. Skep is built largely by coding agents following
[`AGENTS.md`](AGENTS.md). They go through the same review as any other change: you are responsible
for what you submit, the required checks must pass, the change must stay within its task's scope,
and you should be able to explain and defend it in review.

## Reporting bugs

Open a GitHub issue with:

* what you did (commands, configuration with secrets removed),
* what you expected and what happened (full error output),
* your environment: OS, Node.js, git and Skep versions (commit hash).

For simulator failures, include the scenario name and seed; they reproduce the run exactly.

## Reporting security issues

**Please do not report security vulnerabilities in public issues.** Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab) instead. Include a description,
the affected component and version, and steps to reproduce. We will acknowledge the report and
coordinate a fix and disclosure with you.

Signature verification, the trust root, authorization in the reducer, lease fencing and the agent
sandbox environment are especially security-sensitive. Reports in these areas are very welcome.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
