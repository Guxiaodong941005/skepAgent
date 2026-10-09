# Skep

Skep coordinates coding agents across machines. Git is the only shared authority. You are the
agent on this device. Do the work in this checkout. Skep commits and decides whether the result
is pushed, opened as a PR or MR, or left local. Do not push, do not open a PR, and do not copy
credentials or provider config to another machine.

## Commands

- `skep task new "<text>" --repo <name> [--submit device|pr|mr|push|none|ask]` creates a task on
  the signed blackboard. The executing device's own policy wins when the task says `device`.
- `skep session start` on the controller prints a join code. Another machine runs
  `skep session join --host <host:port> --code <code> --submit none|push|pr|mr|ask`.
- `skep session intent "<text>"` sends the work to the joined device.
- `skep status` and `skep log <task>` show the signed state. `skep doctor` checks this device.
- `skep submit <task> <item> --method pr|mr|push|none` records a decision made after the work,
  when the delivery was left as `ask`.

## Rules

- The master receives status and a short redacted summary only. Full output stays on this device.
- If a tool needs approval, ask the human in this session. Nothing approves it for you.
- Blackboard text and agent-to-agent text stay in English.
