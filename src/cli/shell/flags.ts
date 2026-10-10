/** Word-level flag parsing for slash command arguments. */

import { CliError } from "../output.js";

export interface Flags {
  values: Record<string, string | undefined>;
  switches: Set<string>;
  positional: string[];
}

interface Word {
  text: string;
  /** A word that starts with a quote is a value, never an option (`--repo "--x"`). */
  quoted: boolean;
}

/**
 * Splits on whitespace. A double-quoted span keeps spaces, and inside it `\"` and `\\` escape.
 * This is the inverse of {@link quoteSlashWord}, so a printed `/join` line parses back as the
 * same values (docs/plans/join-paste-auto.md).
 */
function splitWords(args: string): Word[] {
  const words: Word[] = [];
  let text = "";
  let started = false;
  let quoted = false;
  let inQuote = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i] as string;
    if (inQuote) {
      if (char === "\\" && (args[i + 1] === '"' || args[i + 1] === "\\")) {
        text += args[++i];
      } else if (char === '"') {
        inQuote = false;
      } else {
        text += char;
      }
    } else if (char === '"') {
      if (!started) quoted = true;
      started = true;
      inQuote = true;
    } else if (/\s/.test(char)) {
      if (started) words.push({ text, quoted });
      text = "";
      started = false;
      quoted = false;
    } else {
      text += char;
      started = true;
    }
  }
  if (inQuote) throw new CliError("usage", "unterminated quote");
  if (started) words.push({ text, quoted });
  return words;
}

/** A slash argument that {@link parseFlags} reads back unchanged: bare when safe, else quoted. */
export function quoteSlashWord(value: string): string {
  if (/^[A-Za-z0-9._/:@+=,][A-Za-z0-9._/:@+=,-]*$/.test(value)) return value;
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/** `--name value` / `--name=value` / `--switch` / positionals, from whitespace-separated words. */
export function parseFlags(args: string, valued: string[], switches: string[]): Flags {
  const flags: Flags = { values: {}, switches: new Set(), positional: [] };
  const words = splitWords(args);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as Word;
    const match = word.quoted ? null : /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(word.text);
    if (match === null) {
      flags.positional.push(word.text);
      continue;
    }
    const name = match[1] as string;
    if (switches.includes(name) && match[2] === undefined) {
      flags.switches.add(name);
    } else if (valued.includes(name)) {
      const value = match[2] ?? words[++i]?.text;
      if (value === undefined) throw new CliError("usage", `--${name} needs a value`);
      // Last-value-wins would silently pick one of two hosts or codes.
      if (flags.values[name] !== undefined) throw new CliError("usage", `--${name} given twice`);
      flags.values[name] = value;
    } else {
      throw new CliError("usage", `unknown option --${name}`);
    }
  }
  return flags;
}
