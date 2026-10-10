# Plan: `/clean` — clear this device's sessions without leaving the shell

Status: implemented on `feat/tui-clean`. Target release: next patch (do **not** bump yet).

## Problem

After a trial the unified shell can keep a session around: this shell's own master or join, a
join handshake that never finishes, or a `session.json` left behind by a master process that is
gone. The only way out today is `/quit`, which also leaves the shell. Users want to reset to
`no session` and `/start` or `/join` again in the same shell.

## Behaviour

`/clean` (alias `/clear`) is always listed, also without a live session, so stale state can be
cleared. It runs **immediately**, not behind the command queue: a `/join` stuck in its handshake
holds the queue, and `/clean` is how the human gets out of it.

In order:

1. Pending questions (join prompts, accept-join, submit choice) are answered with "no answer".
2. A join attempt in flight is dropped from the controller (`SessionController.abortJoin`). When
   the handshake finishes later, `joinStarted` refuses it and `joinCommand` closes the flow (the
   same path `/quit` uses).
3. The shell's own join is closed (`JoinFlow.close`, peer disconnect).
4. The shell's own master is closed (`MasterFlow.close`; it removes its own `session.json`).
5. External probe state is dropped (`SessionController.clearExternal`, which also invalidates any
   discovery in flight).
6. `clearStaleSessionFile` (session.ts) looks at what is left of `session.json`:
   * absent → nothing to do;
   * corrupt, or its master does not answer `status` within the probe timeout → the file is
     removed (only if it still holds the same token, so a master that just started is safe);
   * a master answers → it is a **live master in another process**. `/clean` never stops another
     process; the shell re-discovers it and says so (quit that shell to end it).
7. The UI syncs to the snapshot: `mode: none`, no peers, no bee strip (unless step 6 found a live
   master in another process).

Messages: one `ok` line summarising what was cleared, e.g.
`cleared: stopped master on 192.168.1.20:7419; left 192.168.1.20:7419 as peer-1 — session idle`,
or `nothing to clean — no session on this device`.

The `/join` refusal while joined now reads `already joined (…); /clean leaves the session, /quit
leaves the shell`.

## Files

* `src/cli/shell/run.ts` — `/clean` command, queue bypass, `cleanCommand`, copy.
* `src/cli/shell/session-controller.ts` — `abortJoin`, `clearExternal`.
* `src/cli/commands/session.ts` — `clearStaleSessionFile` (reuses `refuseIfRunning`'s probe and
  `removeOwnSessionFile`).
* Tests: `run.test.ts`, `session-controller.test.ts`, `session.control.test.ts`.
* `CHANGELOG.md` `[Unreleased]`.

## Tests

* idle `/clean` is a no-op with the "nothing to clean" message;
* `/clean` closes an own master (file removed, header `no session`) and `/start` works again;
* `/clean` closes an own join (peer strip gone);
* `/clean` drops a join still in its handshake, and the late flow is closed;
* a stale `session.json` (dead port, corrupt file) is removed; a live other master is kept;
* `/clean` is in `/help` and in the slash menu without a session.

## Out of scope

Stopping a master in another process or on another machine, auto-rejoin, protocol changes,
cancelling `/start` while it is still binding.
