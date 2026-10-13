# Intent peer pick (INTENT-PEER)

Brief: [`intent-peer-pick-BRIEF.md`](intent-peer-pick-BRIEF.md). No wire change, no version bump.

## Behaviour

1. **Lone-peer fallback** (`SessionMaster.route`, `src/session/master.ts`). A bare intent (no
   `repos`) defaults to the master's repo. If no capability candidate works on it and exactly
   one connected candidate answered, the intent is routed to that candidate and planned on its
   repo. The plan is built from the routed requests' repos, not the requested ones. An intent
   with explicit `repos` is never rerouted: unmatched explicit repos still end in `no_match`.
2. **TUI `/intent --repo`** (`parseIntentArgs`, `src/cli/shell/run.ts`). `--repo <name>` or
   `--repo=<name>` may appear anywhere in the `/intent` arguments and may repeat (duplicates are
   dropped); double-quoted repo labels preserve spaces and escaped quotes/backslashes. The rest
   of the line is the intent text. `--repo` without a value is a usage error.
   Free text (no leading `/intent`) is sent verbatim.
3. **Multi-peer picker** (`src/cli/shell/run.ts`, overlay in `model.ts`). When the shown
   master has more than one connected peer and the intent named no repos, the shell shows
   `[ ] peerId  device  repo` rows (`?` when the peer has not described its repo). ↑/↓ move,
   Space toggles, Enter sends (ignored until at least one row is selected), Esc or Ctrl-C
   cancels (`intent cancelled`, nothing sent). Cleanup and shell shutdown also cancel a pending
   picker. The cursor stays visible when the list exceeds the available terminal rows. The
   intent is sent once with the unique repos of the selected peers. If any selected peer has an
   unknown repo, nothing is sent and the shell asks for an explicit `/intent --repo <name> <text>`.
   A master change during selection also refuses the intent. A lone peer skips the picker
   (goal 1 routes it).

## Known limits

* Routing is by repo name: two selected peers on the same repo get one plan item, assigned to
  the earliest joined (`matchSub`). Per-peer assignment would need an additive `peerIds` on the
  intent; left as a follow-up.
* The CLI `skep session intent` has no peer picker; `--repo` there already worked.
* Peers report their repo in response to an intent, not during the join handshake. With several
  newly joined peers, use an explicit `--repo` for the first intent; later picker rows can show
  the discovered repos. An unknown selection must never fall back to the master's repo.

## Acceptance

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Master `futrobomower`, lone peer `skepAgent`: bare intent plans an item on the peer's repo | `master.presence.test.ts` "routes a bare intent to the only peer…" |
| 2 | `--repo skepAgent` routes to the peer | `master.presence.test.ts` "routes an explicit --repo…"; `run.test.ts` "passes /intent --repo…" |
| 3 | Explicit unmatched `--repo` still `no_match` | `master.presence.test.ts` "keeps no_match…", "names the explicit repo…" |
| 4 | Free text is not flag-parsed; lone peer skips the picker | `run.test.ts` "sends a bare intent to a lone peer…" |
| 5 | Picker: toggle, Enter needs ≥1, sends unique repos; Esc cancels; `--repo` skips it | `run.test.ts` picker tests |
| 6 | Shell peers carry `repo` from master status | `session-controller.test.ts` |
| 7 | Two Git dirs, different basenames: bare and explicit intents complete in the peer cwd | `run.test.ts` "completes bare and explicit intents…", real loopback sockets and an injected fake agent process |
| 8 | Unknown repo selection, master replacement, shutdown, short-terminal viewport | Added review regressions in `run.test.ts` and `model.test.ts` |

The automated checkout smoke uses a fake agent. A real vendor CLI smoke remains a manual check
per the BRIEF. See [`../reviews/intent-peer-pick.md`](../reviews/intent-peer-pick.md) for the review.
