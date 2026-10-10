/**
 * The CLI's version, in its own module so `tui.ts` can show it without importing `program.ts`
 * (which imports the commands, and so the TUI: a cycle). Bumped with `package.json`.
 */
export const SKEP_VERSION = "0.1.7";
