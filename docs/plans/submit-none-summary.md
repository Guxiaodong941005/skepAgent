# Default submit `none` + agent summary in the master's scrollback

## Problem

Trial use (master operator on one machine, peer on another) showed two gaps:

1. A joined device without `device.toml` `[submit]` fell back to `ask`, so every item that
   changed the repo stopped on `Submit this item? [pr/mr/push/none/skip]`. With auto mode as
   the join default, this was the only prompt left, and it fired on every item.
2. The peer logged `item I-N <first summary line> (<sha>)`, but the master only saw
   `result-ack I-N`. The operator could not read what the peer agent produced without opening
   a shell on the peer.

## Behaviour

### Default submit `none`

* `loadSubmitPolicy` (`src/cli/commands/session.ts`), the loose loader that join uses, now
  defaults to `{ method: "none", host: "github" }` for a missing file, a file without
  `[submit]`, a missing `method`, and a file that fails to parse (including an unknown method).
  The parse-failure warning says `falling back to none`.
* Host `git` still forces `push`. `--submit pr|mr|push|none|ask` still overrides, and
  `[submit] method = "ask"` still asks.
* With `none`, an item that changed the repo is committed on its local session branch
  (`submit none local`); there is no submit prompt.
* The core `DeviceSubmitSchema` (`src/core/schemas/config.ts`) keeps its own `pr` default: it
  describes a full, written `device.toml`, is owned by core, and join does not read it. Not
  conflating the two keeps this change inside the session loader.
* Copy updated: the joined line (`controlText`) now reads `submit: none` by default and
  `submit: ask after each item that changed the repo` for `ask`; `/join` usage, the shell help,
  `skep session join --help`, CHANGELOG.

### Agent summary in the master's scrollback

* When the master accepts a `result` (`applyResult` → `result-ack`), it emits
  `onEvent({ kind: "item-result", message: "I-4: <summary>" })` instead of
  `result-ack I-4`. The summary is the stored one, i.e. already redacted on the sub and again on
  apply (D19).
* Cap (`scrollbackSummary` in `src/session/master.ts`): the first 8 non-empty lines, at most
  600 characters; ` …` marks a cut; an empty summary shows `(no summary)`. The wire allows 4000
  characters, which is too much for an operator's scrollback; the full text stays in item state.
* A rejected result emits `result-reject` with `I-5: <reason>`; the shell logs it as an error
  line `result rejected I-5: <reason>`.
* `src/cli/shell/run.ts` `masterEvent` logs `item I-4: <summary>` as an event line. `progress`
  stays footer-only.
* `skep session start` (non-TUI) does not print master `onEvent` lines today; that is
  unchanged, so the TUI scrollback is where the summary appears.

## Files

* `src/cli/commands/session.ts`: default policy, warning, help/joined-line copy.
* `src/cli/shell/join-args.ts`, `src/cli/shell/run.ts`: usage/help copy, `item-result` and
  `result-reject` events.
* `src/session/master.ts`: `scrollbackSummary`, event on accepted/rejected results.
* Tests: `src/cli/commands/session.test.ts`, `src/cli/shell/run.test.ts`,
  `src/session/master.progress.test.ts`.
* `CHANGELOG.md` `[Unreleased]`; a pointer in `docs/plans/join-paste-auto.md`.

## Tests

* `loadSubmitPolicy` defaults/fallbacks are `none` (missing file, no `[submit]`, bad method,
  unparsable TOML); explicit `ask` is kept.
* A join with neither `--submit` nor `device.toml` reports `none`/`local` and never prints
  `Submit this item?`; `device.toml` `method = "ask"` and `--submit ask` still ask.
* A real master + sub: the accepted result produces one `item-result` event with the summary,
  a planted token redacted, and no summary text in `progress` events.
* `scrollbackSummary` line and character caps.
* Shell: `item-result` and `result-reject` reach the scrollback; `progress` does not.

## Out of scope

Version bump / publish, auto/manual semantics, the core device schema default, printing master
events in non-TUI `skep session start`, agent approval flags (D29).
