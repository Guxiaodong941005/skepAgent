---
schema: skep.agent/v1
role: coding
agent_cli: codex
cli_version: "pinned-1.2.3"
repos:
  - git@example.com:owner/app.git
capabilities: [typescript, unit-tests]
requires_local: [xcode]
max_parallel_items: 1
budgets:
  max_invocation_minutes: 45
---

# Responsibilities
Implement application code and unit tests for assigned work items.

# Boundaries
- Never modify files under design/.
- Do not attempt to push; the daemon does this.
