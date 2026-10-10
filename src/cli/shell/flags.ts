/** Word-level flag parsing for slash command arguments. */

import { CliError } from "../output.js";

export interface Flags {
  values: Record<string, string | undefined>;
  switches: Set<string>;
  positional: string[];
}

/** `--name value` / `--name=value` / `--switch` / positionals, from whitespace-separated words. */
export function parseFlags(args: string, valued: string[], switches: string[]): Flags {
  const flags: Flags = { values: {}, switches: new Set(), positional: [] };
  const words = args.split(/\s+/).filter((word) => word !== "");
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(word);
    if (match === null) {
      flags.positional.push(word);
      continue;
    }
    const name = match[1] as string;
    if (switches.includes(name) && match[2] === undefined) {
      flags.switches.add(name);
    } else if (valued.includes(name)) {
      const value = match[2] ?? words[++i];
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
