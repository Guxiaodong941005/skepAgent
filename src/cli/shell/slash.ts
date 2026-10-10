/**
 * Slash command registry for the unified shell (docs/plans/unified-tui-shell.md §4).
 *
 * TODO(merge feat/unified-tui-shell-ui): temporary stub so `run.ts` compiles before the UI branch
 * lands. Replace with the UI branch's `slash.ts`; keep the `SlashCommand`/`SlashResult` shapes.
 */

/** What a command's `visible` predicate may look at. */
export interface ShellCtx {
  /** A master runs in this shell, or this shell joined one. */
  sessionLive: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  argsRequired?: boolean;
  /** Return false to hide from menu (still runnable if fully typed). */
  visible?: (ctx: ShellCtx) => boolean;
  run: (ctx: ShellCtx, args: string) => Promise<SlashResult> | SlashResult;
}

export type SlashResult =
  | { type: "ok"; message?: string }
  | { type: "error"; message: string }
  | { type: "quit" };

/** `/name args` → name and the rest; null when `text` is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text.trim());
  if (match === null) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | null {
  return (
    commands.find((command) => command.name === name || command.aliases?.includes(name)) ?? null
  );
}

/** Visible commands matching `query`: prefix matches first, then subsequence matches. */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
  ctx: ShellCtx,
): SlashCommand[] {
  const q = query.toLowerCase();
  const visible = commands.filter((command) => command.visible?.(ctx) ?? true);
  const prefix = visible.filter((command) => command.name.startsWith(q));
  const subsequence = visible.filter(
    (command) => !command.name.startsWith(q) && isSubsequence(q, command.name),
  );
  return [...prefix, ...subsequence];
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) if (char === needle[at]) at += 1;
  return at === needle.length;
}

export function commandLabel(command: SlashCommand): string {
  return command.usage === undefined ? `/${command.name}` : `/${command.name} ${command.usage}`;
}
