# Session UX rethink: no worktrees, no AGENT.md, no fake success (SESSION-UX)

Status: design. No code in this change. Do **not** `npm publish` from this work and do not bump
the package version until the MVP slice below has been implemented *and reviewed*.

## 0. Why this exists

Verbatim user feedback (Chinese), then the English paraphrase:

> 「为什么这么麻烦？这种产品用户能使用么？反馈给 vps 的 claude，让他重新整理产品体验，把这些复杂的流程都简化，
> 不要使用 worktree，直接修改代码就行了，也不要强制使用 agent.md，就只做 agent 们之间的沟通调用 和数据汇总整理就行了。」

"Why is this so painful? Can a normal user use this? Rethink the product experience and remove the
complicated flows. Do not use worktrees; edit the code directly. Do not mandate AGENT.md. Skep
should only do agent-to-agent communication/dispatch and result aggregation/summarisation."

The feedback comes from a real session (a Mac peer joined to a box master). The product job is:

> One human types an intent on the master. Skep routes it to agents on other devices/projects,
> shows progress, and brings back **one readable summary of what changed**.

Everything that is not that job (session branches, worktree directories, per-device AGENT.md
files, submit rituals) is cost the user pays for no benefit they asked for.

## 1. Honest critique of the current session UX

All paths are `src/cli/commands/session.ts` at v0.1.10 unless noted.

| # | What the user hits | Where it lives | Why it is wrong for the goal |
|---|--------------------|----------------|-------------------------------|
| 1 | `--agent pty\|native needs this device's AGENT.md (pass --role-dir)` | `agentCliOf` (~L2578) called from `joinSessionFlow` (~L2313) when `view !== "dry"` and no `opts.cli` | The user already said which agent (`--agent native`) and still must author a role file whose only used field is `agent_cli`. `/agent` in the shell sets `opts.cli`, but that is an undiscoverable second route. PRD D27 ("the master never chooses the CLI") only requires that the *peer* decides, not that a file decides. |
| 2 | `materialize: skep/session/I-1-e1 or <dir> already exists; submit or delete it first` | `materializeItem` (~L806): branch `sessionBranch(itemId, epoch)`, dir `<root>/<repo>-<itemId>-e<epoch>` | Item ids **restart in every session** (the code comment says so), so the *second* session on a device always collides with the leftover of the first. The guard exists to never clobber unsubmitted work, but with default submit `none` *every* finished item is unsubmitted work, so the guard fires on the normal path. |
| 3 | Leftovers under two roots | `worker.root = <paths.home>/session/worktrees` (~L2330). `paths.home` is `~/.skep` for old installs and `~/.skep/projects/<id>` since per-project isolation (`skepHome`, `src/config/paths.ts`) | Branches live in the *repo* (global to both homes) while directories live in the *home* (split). Cleanup must therefore be done in two places and the git side is shared. |
| 4 | Peer "succeeds" without doing anything | `executeItem` (~L1240): `setup === undefined \|\| view === "dry"` writes `.skep-session-item`, commits it, returns `status: "ok", changed: true, summary: "dry run: committed the session marker (no agent configured)"`. `selectAgentView` returns `"dry"` unless `--agent` or `SKEP_SESSION_EXEC=1` | The default of a joined peer is a fake. It looks like progress (a new commit, a green bee, a result-ack on the master) and burns an item id. It is the single worst trust-breaker in the product. |
| 5 | Errors are cut off | `Shell` frame builder (`src/cli/shell/model.ts` ~L131) runs `truncate(line, columns)` / `fitSpans` on every body line; `scrollback` entries are one row each. Master side `scrollbackSummary` caps at 8 lines/600 chars | The one message that explains the failure (`materialize: … already…`) is exactly the long one. The user cannot read the path or the remedy. |
| 6 | Manual ritual cleanup | `git worktree remove --force`, `git worktree prune`, `git branch -D 'skep/session/I-N-e1'`, over two homes; zsh glob needs quotes; `xargs -r` is GNU-only | Self-inflicted by 2+3. `/clean` (`Shell.cleanCommand`) ends the *connection state*, not the git state, so it cannot help. |
| 7 | Result is a branch name, not an answer | `submitBranch`, `submitLine`; summary is `submit none local` + the agent tail | The master user wants "what changed and did it work". Today they get a branch they must find on another machine. |
| 8 | Two overlapping vocabularies | `--agent` takes a *view* (`dry\|pty\|herdr\|native`), `/agent` takes a *CLI* (`codex\|claude\|pi`), AGENT.md has `agent_cli`, `SKEP_SESSION_EXEC`/`SKEP_SESSION_VIEW` env vars | Four ways to configure one decision, with different names. |

Root cause: the peer was designed as a *PR-producing contributor* (isolated checkout, branch,
checks, submit) and the product goal is a *dispatcher/aggregator*. The git machinery is correct
for the former and pure friction for the latter.

### Superseded work

The following in-flight patches become moot once worktrees leave the product path and are
**superseded by this plan**; do not land or continue them:

* `fix/auto-detect-session-agent` (agent default patch): replaced by §3.2 auto-detect, which also
  fails loudly instead of defaulting to dry.
* Leftover worktree-reuse / collision fixes (reusing an existing `skep/session/*` branch,
  `worktree prune` on start, root unification between the two homes): the thing they repair no
  longer exists.
* The "clean up stale session worktrees on `/clean`" idea: nothing to clean.

Not superseded: per-project home isolation (`feat/project-session-isolation`, shipped in 0.1.9)
and SAME-CB (peer without Git HEAD, 0.1.10). Both are about *where state lives* and *which
master a shell talks to*, which still matters. See §4.

## 2. Target UX

Principle: a user types three things and sees a result. No file to author, no branch to know.

```text
master$ skep
> /start
  master up · join code 4821-7730-1156 · 192.168.1.20:7419
  peers: none yet. On the other device run:  /join 192.168.1.20:7419 4821-7730-1156

peer$ cd ~/work/app && skep
> /join 192.168.1.20:7419 4821-7730-1156
  joined · repo app · agent: claude (found on PATH) · mode: edits this folder directly

master> /intent add input validation to the signup form
  I-1 → mac (app) · working…
  I-1 done · mac · 3 files changed (+41 −7)
      src/signup/form.ts, src/signup/validate.ts, test/signup.test.ts
      "Added zod validation for email and password; tests updated and passing."
```

### 2.1 Commands

| Command | Behaviour (target) |
|---------|--------------------|
| `/start` | Start the master in this project. Prints the join line to paste. No repo/AGENT.md prerequisites. (unchanged apart from copy) |
| `/join <host:port> <code>` (paste forms from `join-paste-auto.md` still work) | Joins. **Resolves the agent at join time** (§3.2) and prints which one, or fails with one actionable message. Flags: `--agent <claude\|codex\|pi>` (CLI), `--manual` (confirm each item), `--submit …` (advanced). `--role-dir` is accepted and ignored with a deprecation note. |
| `/intent <text>` | Send work. Master shows per-peer progress and, on completion, the aggregated result (§2.3). |
| `/status` | Peers, what each is doing, and the **last result per intent** including its full summary. Never truncated: wraps (§3.4). |
| `/agent [claude\|codex\|pi]` | Show/set this device's agent CLI. Persisted per project (device.toml `[agent]`), so it is a real setting rather than a session-only override. |
| `/clean` | Ends the connection state (as today). Because there is no git state, this is the *only* cleanup anyone ever needs. It also prints `nothing left on disk` so users stop looking. |
| `/help`, `/quit` | unchanged |

### 2.2 What a peer does on an item

1. Resolve the working directory: the git top level of the cwd the peer shell was started in
   (`git rev-parse --show-toplevel`; if not a git repo, the cwd itself. SAME-CB already tolerates a
   repo without HEAD).
2. Record `before = { head, dirty = porcelain status }`.
3. Run the agent **in that directory**. The prompt is the item title (as today) plus a short fixed
   preamble ("work in the current directory; end with a brief summary of what you changed").
   Execution view stays native/non-interactive by default (`claude -p`, `codex exec -`);
   pty/herdr remain opt-in via `--view`.
4. After the agent exits, compute `after` and the **delta**: files whose content/status changed
   relative to `before` (see §3.3 for the dirty-tree rule), plus a diffstat.
5. Report: `status` (done / failed / blocked), changed files, diffstat, agent summary tail,
   `headSha` (HEAD after; usually equal to before because nothing is committed).
6. Do **not** create a branch, a worktree, a clone, or a commit unless the user opted into a submit
   mode that needs one (§3.3).

Items on one peer are processed **one at a time**: they share a working tree, so parallel items
would interleave edits. The master already tolerates a busy peer; the queue is the peer's.

### 2.3 What the master shows when work finishes

A single block per item, always complete, wrapped to the terminal:

```text
I-1 done · mac (app) · claude · 2m 14s
  changed 3 files (+41 −7): src/signup/form.ts, src/signup/validate.ts, test/signup.test.ts
  summary: Added zod validation for email and password; tests updated and passing.
```

Failure is equally loud and equally specific:

```text
I-2 FAILED · mac (app) · no agent CLI found (looked for claude, codex, pi on PATH).
  fix on mac: install one, or run  /agent claude
```

For several peers on one intent, `/status` prints one block per peer under the intent plus a
one-line roll-up (`2 done · 1 failed · 4 files changed`). Richer cross-peer summarisation is
Phase 2.

## 3. Design decisions

### 3.1 No git worktrees, no session branches on the default path

* Delete `materializeItem`, `syncBack`, `Materialized`, the `worktree` worker option and the
  `<home>/session/worktrees` root. The agent's `cwd` becomes the project root.
* `sessionBranch()` stops being a required identity. The wire `SubmitOutcome.branch` is a required
  non-empty string (`src/session/messages.ts` L114); the MVP fills it with the checked-out branch
  name (or `HEAD` when detached). **No wire change.**
* Trade-off, stated plainly: the agent edits the user's real files. That is what the user asked
  for, and it is what `claude`/`codex` do in a normal terminal anyway. The mitigation is
  reporting (the delta), not isolation. An optional sandbox is Phase 3.

### 3.2 Agent resolution, never a fake

Order, first hit wins, evaluated **once at join** (so the user learns immediately):

1. `--agent <claude|codex|pi>` on `/join`.
2. `/agent <cli>` / `device.toml` `[agent] cli = "…"` (new, optional, tiny).
3. `SKEP_AGENT_CLI` env.
4. AGENT.md `agent_cli` **if the file happens to exist** (back-compat only; never required, never
   prompted for).
5. Auto-detect: first of `claude`, `codex`, `pi` found on `PATH` (execFile `which`-equivalent via
   PATH scan; no shell).
6. Otherwise `/join` **fails** with: `no agent CLI found (looked for claude, codex, pi on PATH).
   Install one or pass --agent <cli>.` The peer does not join and nothing is dispatched to it.

The legacy values of `--agent` (`pty`, `native`, `herdr`, `dry`) are *views*, not CLIs. During the
deprecation window `--agent pty|native|herdr` is accepted, mapped to `--view`, and prints one line
(`--agent pty is now --view pty`). `SKEP_SESSION_EXEC`/`SKEP_SESSION_VIEW` are honoured for one
release, then removed.

**`dry` is no longer a default and never "succeeds".** If kept at all it is
`--view dry`/`--dry-run`, test and demo only; it commits nothing, writes no marker file, and
reports `status: "failed"`-class with `summary: "DRY RUN: no agent ran, nothing changed"` so
the master can never mistake it for work. (`MARKER_FILE`, the marker commit and
`dry run: committed the session marker` are deleted.)

### 3.3 Submit modes, simplified

`device.toml` `[submit]` and `--submit` keep their names so existing configs still parse, but the
semantics now start from the working tree:

| Mode | Meaning now |
|------|-------------|
| `none` (default) | Leave edits in the working tree, uncommitted. Reported as `submit none local`. |
| `commit` (new, tiny) | `git add -A && git commit` of **only the delta files** on the current branch. |
| `push` | commit as above, then push the current branch. |
| `pr` / `mr` | create `skep/<itemId>-<slug>` **at submit time** from the working tree, push, open PR/MR, switch back. This is the only place a session branch can appear, and it is opt-in. |
| `ask` | unchanged prompt, offered after a changed item. |

`skep session submit <item>` keeps working by operating on the recorded delta instead of on a
pre-existing branch. In the MVP it may simply say `use submit none/commit; branch-based submit is
Phase 2` for `pr/mr/push` if the full port is too large (see §5 risk list).

**Dirty tree rule.** The tree may already be dirty. MVP behaviour: run anyway (the user asked),
capture a per-file content hash snapshot before, and report only files whose hash differs after.
Files that were already dirty *and* changed are reported with `(was already modified)`. Never
`git stash`, `reset`, or `clean`.

Checks (`runChecks`, `CHECKS_FILE_PATH`) stay: they now run in the project root after the agent
and are shown in the result line. Failing checks no longer block anything because nothing is
submitted by default; they are information.

### 3.4 Errors are readable

* Shell scrollback entries that are tagged error/warn are **word-wrapped** to the terminal width
  with a hanging indent rather than `truncate`d (`Shell` body line builder in
  `src/cli/shell/model.ts`). Other tones keep truncation.
* Peer-side failures are summarised as **one cause line + one fix line**, and the full text is
  also written to `<home>/session/last-error.log` with the path printed. The cause line itself
  must never need more than ~2 wrapped rows.
* Master `scrollbackSummary` cap (8 lines / 600 chars) stays for success summaries but is lifted
  for `FAILED` blocks.

## 4. Migration

### Remove

| Thing | Where | Notes |
|-------|-------|-------|
| Worktree/clone materialisation | `materializeItem`, `syncBack`, `Materialized`, `ItemWorker.worktree`, `ItemWorker.root`, `session/worktrees` path | Core of the pain. |
| Session branch as required identity | `sessionBranch` use in `runItem`; collision guard text | Branch name only appears under `pr`/`mr`. |
| AGENT.md gate | `agentCliOf` throwing `agent_md`; `--role-dir` requirement | Keep reading AGENT.md opportunistically (§3.2 step 4). |
| Dry-run fake success | `executeItem` dry branch, `MARKER_FILE`, `selectAgentView` → `"dry"` default | Replace with resolve-or-fail. |
| `SKEP_SESSION_EXEC` as the switch that turns on real work | `selectAgentView` | Real work is the default. |
| Doc/test instructions for manual worktree cleanup | CHANGELOG, plans | One line in the release notes telling 0.1.x users they may `git worktree prune` once. |

### Keep

* Session wire and schemas (`src/session/messages.ts`): unchanged in the MVP.
* Routing, intents, datalist wait, master `item-result` scrollback, result-ack.
* Peer progress bee (`peer-progress-bee.md`): states stay `working/blocked/failed/done`.
* Submit modes and `device.toml` `[submit]` (semantics per §3.3).
* Per-project home isolation (`skepHome`/`projectId`) and same-machine multi-project discovery
  (`multi-project-same-machine.md`). They are still needed: session pointer, listener port, device
  token and transcripts are per project, even with no worktrees. What *does* disappear is the
  second `session/worktrees` tree, which was the cause of the "two roots" confusion.
* SAME-CB: peers without Git HEAD keep working (`deviceHead()` and `UNKNOWN_SHA` stay).
* Native/pty/herdr runners, `NATIVE_ARGV`, transcripts journal, blocked/focus handling (D29).
* Redaction (`Redactor`) of summaries (D19).

## 5. Phased plan

### Phase 1 (MVP): "run in place, fail loudly, show the whole error"

Smallest change that makes every live pain in the report go away, with **no wire change**:

1. Run the agent in the project root; no worktree/clone/branch (`runItem` skips
   `materializeItem`).
2. Drop the AGENT.md requirement; resolve the agent per §3.2; fail at `/join` if none.
3. Remove the dry default and marker commit; a real agent is required.
4. Compute and report the changed-file delta + diffstat; `submit none` leaves the tree alone.
5. Wrap error/warn scrollback lines instead of truncating them; print full cause on peer failure.
6. Serialize items per peer.

Out of the MVP on purpose: branch-based `pr/mr/push` port, `commit` mode polish, cross-peer
roll-up, `device.toml [agent]`, sandbox.

### Phase 2: aggregation and submit

* Per-intent roll-up across peers in `/status` and a final "intent done" block.
* `commit/push/pr/mr` ported to the delta model; `skep session submit` rewritten on it.
* `device.toml [agent] cli` and `/agent` persistence; remove deprecated `--agent pty|native` alias
  and `SKEP_SESSION_EXEC`.
* Optional master-side digest: a second model pass that merges N peer summaries (opt-in; costs
  tokens).

### Phase 3: optional safety

* `--sandbox` (opt-in): copy-on-write snapshot (`git stash create` / patch capture) or a plain
  temp copy for users who want isolation. Explicitly **not** git worktrees.
* Undo: `skep session undo <item>` applying the reverse of the recorded delta.
* Concurrent items per peer via sandboxes.

## 6. MVP file-touch list

| File | Change |
|------|--------|
| `src/cli/commands/session.ts` | `runItem` (~L1500–1690): remove `materializeItem`/`syncBack`/`branch`; use project root as `dir`; before/after delta; `executeItem`: delete dry branch + `MARKER_FILE`; `selectAgentView`: default to `native`, accept legacy values; `joinSessionFlow` (~L2300): resolve agent (new `resolveAgentCli`), fail at join; `agentCliOf`: demote to optional step; `ItemWorker`: drop `root`/`worktree`; `materializeItem`/`syncBack`/`Materialized`: delete; `submitBranch`: tolerate current-branch for `none` (already `local`). Per-peer serial queue next to `terminal`. |
| `src/cli/shell/join-args.ts` | `--agent` accepts CLI names; legacy view names mapped with a notice; `--role-dir` tolerated; usage text. |
| `src/cli/shell/run.ts` | `joinCommand` copy (shows chosen agent), `/agent` help text; `/clean` message. |
| `src/cli/shell/model.ts` | wrap (not truncate) error/warn scrollback lines in the frame builder. |
| `src/cli/shell/session-controller.ts` | surface the resolved agent/cause line from join failures. |
| `src/session/master.ts` | `scrollbackSummary`: no cap for failed results; changed-file line formatting (summary text only, no schema change). |
| Tests | `src/cli/commands/session.test.ts`, `session.control.test.ts`, `src/cli/shell/{model,run,join-args,session-controller}.test.ts`, and an integration test under `test/integration/`. Existing tests asserting worktree/branch/marker behaviour are rewritten, not skipped. |
| Docs | `CHANGELOG.md`, `docs/plans/tui-session-reliability*.md` cross-link; PRD/ARCHITECTURE session sections get a "superseded by SESSION-UX" note in the same PR. |

Per CLAUDE.md rule 1 the implementer must keep to these files and should not touch `src/core/**`.

## 7. Risks / open questions

* **Dirty working tree attribution** is best-effort (content hashes). Acceptable for MVP; Phase 3
  sandbox is the real answer.
* **`skep session submit` and old per-session branches** from 0.1.x: either keep a read-only
  compat path that still understands `skep/session/*`, or print a one-time "legacy branch,
  use git directly". Decide during implementation; do not auto-delete anyone's branches.
* **Agent edits while the human is also editing** the same tree on the peer. Documented in help;
  `--manual` confirmation remains the guardrail.
* **PRD D27/D28/D29 wording** mentions AGENT.md and session branches; the PRD is normative, so the
  implementing PR must amend those lines rather than silently diverge.
* **Wire**: `SubResult.baseSha/headSha` are required `ShaSchema`; non-repo directories continue to
  use `UNKNOWN_SHA` as SAME-CB does.

## 8. Publishing

Do **not** `npm publish` from this planning work. Do not bump `package.json` until the MVP has
been implemented, reviewed (`docs/reviews/`) and `npm run lint && npm test` is green.
