/**
 * Slash command registry for the unified shell (docs/plans/unified-tui-shell.md §4).
 * Fuzzy ranking from feat/unified-tui-shell-ui; wire-compatible exports for run.ts.
 */

export interface ShellCtx {
  /** Prefer hiding session-only commands when false. */
  sessionLive?: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  argsRequired?: boolean;
  visible?: (ctx: ShellCtx) => boolean;
  run: (ctx: ShellCtx, args: string) => Promise<SlashResult> | SlashResult;
}

export type SlashResult =
  | { type: "ok"; message?: string }
  | { type: "error"; message: string }
  | { type: "quit" };

export const MAX_SLASH_ROWS = 6;

export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? null : { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | null {
  const token = name.toLowerCase();
  return (
    commands.find(
      (command) =>
        command.name.toLowerCase() === token ||
        command.aliases?.some((alias) => alias.toLowerCase() === token),
    ) ?? null
  );
}

export function commandLabel(command: SlashCommand): string {
  return command.usage === undefined ? `/${command.name}` : `/${command.name} ${command.usage}`;
}

function matchScore(name: string, token: string): [number, number] | null {
  if (token === "") return [0, 0];
  if (name.startsWith(token)) return [0, 0];
  let position = 0;
  let gaps = 0;
  for (const char of token) {
    const found = name.indexOf(char, position);
    if (found < 0) return null;
    gaps += found - position;
    position = found + 1;
  }
  return [1, gaps];
}

/** Fuzzy-filter visible commands by the token after `/` (prefix, then subsequence). */
export function matchCommands(
  commands: readonly SlashCommand[],
  token: string,
  ctx: ShellCtx = {},
): SlashCommand[] {
  const query = token.toLowerCase();
  const matches: { command: SlashCommand; score: [number, number]; index: number }[] = [];
  commands.forEach((command, index) => {
    if (command.visible?.(ctx) === false) return;
    let score: [number, number] | null = null;
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const candidate = matchScore(name.toLowerCase(), query);
      if (
        candidate !== null &&
        (score === null ||
          candidate[0] < score[0] ||
          (candidate[0] === score[0] && candidate[1] < score[1]))
      ) {
        score = candidate;
      }
    }
    if (score !== null) matches.push({ command, score, index });
  });
  matches.sort(
    (left, right) =>
      left.score[0] - right.score[0] || left.score[1] - right.score[1] || left.index - right.index,
  );
  return matches.slice(0, MAX_SLASH_ROWS).map(({ command }) => command);
}
