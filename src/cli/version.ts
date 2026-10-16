/**
 * The CLI's version, in its own module so `tui.ts` can show it without importing `program.ts`
 * (which imports the commands, and so the TUI: a cycle). Unreleased branches use a `-dev`
 * suffix so they are distinguishable from the last published release. The release task sets
 * this to the version in `package.json`; session protocol negotiation uses its own version.
 */
export const SKEP_VERSION = "0.2.0";
