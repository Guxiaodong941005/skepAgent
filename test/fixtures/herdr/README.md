Fixtures target the locally installed herdr 0.9.3 (protocol 22, schema version 1).

`wait.json` and `error-prompt-stalled.json` are sanitized local CLI captures. Identifiers,
titles and worktree paths are replaced with generic placeholders. The other success and error
examples use the shapes exported by the local `herdr api schema --json`, including the
`root_pane` field and the `id`/`result` or `id`/`error` envelope. `schema.json` retains the
compatibility fields from that export. Live socket calls were denied by the sandbox, so the
additional examples are schema-based fixtures, not newly recorded session calls.
