# Peer progress bee — ready for parent review

Branch: `feat/peer-progress-bee` (on VPS `/root/skep`)
Base: `main` @ `08cc13e` (v0.1.2)
**Do not npm publish / tag yet.** Version stays 0.1.2; CHANGELOG has `[Unreleased]`.

## What shipped

Bidirectional peer status strip in session TUI over live session messages (no blackboard):

- Flying bee = peer `working` / pulse when `blocked`
- Progress bar + % = assigned items done/total (MVP metric in plan §3)
- A sees B and B sees A via master relay; `skep ui` shows all via `status().peers[].progress`

## Branches

| Branch | Role |
|---|---|
| `feat/peer-progress-bee-protocol` | Claude: protocol + tests |
| `feat/peer-progress-bee-ui` | Codex: TUI/CLI + tests |
| `feat/peer-progress-bee` | Merge of both + small cleanup |

## Commits on integration branch

```
3d2d289 test(cli): expect idle peer progress strip after join
d34f2a3 refactor(cli): use shared PeerPhase/PeerProgress from session protocol
5a38ed5 Merge branch feat/peer-progress-bee-ui into feat/peer-progress-bee
dad4b4a feat(tui): show peer progress bee and bar
be8a589 feat(session): add peer progress messages and relay
8e052be feat(session): add peer progress contract types and schema
… docs(plans): peer progress bee implementation plan
```

Plan: `docs/plans/peer-progress-bee.md`

## Validation done

- Focused: progress + master.progress + tui + ui + session tests green after merge
- Pre-existing main issues left alone: missing `src/sim/rng.js` (backoff.test), missing config fixtures, biome formatting elsewhere

## Notes / deviations for review

1. `SubHandle.reportAgent` is **optional** (`reportAgent?`) so fake session APIs in CLI tests keep compiling. Real `connectSub` always provides it. CLI uses optional call.
2. Progress bar fill at 37% uses **3 cells** to match the plan frame example (Codex note: conflicts slightly with floor(percent/12.5) which would be 2).
3. Opt-in: only peers that send progress receive relays (0.1.2 subs stay connected). Upgrade master first.
4. Duplicate plan commits exist (protocol + ui each committed the plan); harmless.

## Demo / 联调 (parent)

```bash
# Device A
skep session start --device a --listen <ip>:7419 --repo skep --yes
skep session join --ui   # or join with exec agent

# Device B
skep session join --host <A-ip>:7419 --code <code> --ui --device b --repo <other-or-same>

# Then on master: skep session intent "…"
# Watch peer strips: bee flies while working, then ✓ 100%.
# Optional: skep ui on master; SKEP_TUI_ASCII=1 for ASCII glyphs.
```

## Parent next steps

1. Code review against plan acceptance checklist §8
2. Manual box↔VPS 联调
3. Merge to main when happy
4. Separate release commit → 0.1.3 + npm (not done here)
