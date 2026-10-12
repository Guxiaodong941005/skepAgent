/**
 * `/join` argument grammar (docs/plans/tui-session-reliability.md §3). Positionals are classified
 * by shape, so `/join <host:port> <code>` and `/join <code> --host <host:port>` both work.
 */

import {
  AGENT_VIEWS,
  type AgentCli,
  type AgentView,
  normalizeJoinCode,
  parseAgentFlag,
  parseHostPort,
  SUBMIT_METHODS,
} from "../commands/session.js";
import { CliError } from "../output.js";
import { parseFlags } from "./flags.js";

/**
 * Codes are one word: `8632-1727-0308` or `863217270308` (arguments split on whitespace). The
 * first form is the line the master prints to paste (docs/plans/join-paste-auto.md).
 */
export const JOIN_USAGE = [
  "usage: /join --host <host:port> --code <NNNN-NNNN-NNNN> --repo <repo>",
  "       /join <NNNN-NNNN-NNNN> [--host host:port]",
  "       /join <host:port> <NNNN-NNNN-NNNN>",
  "       /join            (this device's own master)",
  "options: --agent claude|codex|pi (default: /agent, SKEP_AGENT_CLI, else found on PATH),",
  "         --manual (confirm each item; default auto),",
  "         --submit commit|push|pr|mr|none|ask (default: device.toml, else none),",
  "         --view native|pty|herdr|dry, --role <role>, --device <name>",
].join("\n");

export interface JoinArgs {
  code?: string;
  host?: string;
  role?: string;
  /** The agent CLI. */
  agent?: AgentCli;
  /** How the agent runs; also set by a legacy `--agent pty|native|herdr|dry`. */
  view?: AgentView;
  repo?: string;
  device?: string;
  submit?: (typeof SUBMIT_METHODS)[number];
  /** Opt out of auto control. */
  manual?: boolean;
  /** One-line notices for the human (deprecated spellings, ignored flags). */
  notes?: string[];
}

function usage(problem: string): CliError {
  return new CliError("usage", `/join: ${problem}\n${JOIN_USAGE}`);
}

export function parseJoinArgs(args: string): JoinArgs {
  let flags: ReturnType<typeof parseFlags>;
  try {
    flags = parseFlags(
      args,
      ["host", "role", "agent", "view", "code", "repo", "device", "submit", "role-dir"],
      ["manual"],
    );
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error));
  }
  const { code: codeFlag, host: hostFlag, role, repo, device, submit } = flags.values;
  const notes: string[] = [];
  let choice: ReturnType<typeof parseAgentFlag>;
  try {
    choice = parseAgentFlag(flags.values.agent);
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error));
  }
  if (choice.notice !== undefined) notes.push(choice.notice);
  const viewFlag = flags.values.view;
  const view = AGENT_VIEWS.find((value) => value === viewFlag) ?? choice.view;
  if (viewFlag !== undefined && view !== viewFlag) {
    throw usage(`--view must be ${AGENT_VIEWS.join(", ")}, got ${viewFlag}`);
  }
  // Tolerated so old paste lines still work; AGENT.md is no longer required (SESSION-UX §3.2).
  if (flags.values["role-dir"] !== undefined) {
    notes.push("--role-dir is ignored; AGENT.md is no longer required");
  }
  const method = SUBMIT_METHODS.find((value) => value === submit);
  if (submit !== undefined && method === undefined) {
    throw usage(`--submit must be ${SUBMIT_METHODS.join(", ")}, got ${submit}`);
  }
  if (codeFlag !== undefined && normalizeJoinCode(codeFlag) === null) {
    throw usage(`--code must be 12 digits, got ${codeFlag}`);
  }
  if (hostFlag !== undefined && parseHostPort(hostFlag) === null) {
    throw usage(`--host must be host:port, got ${hostFlag}`);
  }
  let code = codeFlag;
  let host = hostFlag;
  if (flags.positional.length > 2) throw usage("too many arguments");
  for (const word of flags.positional) {
    if (normalizeJoinCode(word) !== null) {
      if (code !== undefined) throw usage(`two join codes (${code}, ${word})`);
      code = word;
    } else if (parseHostPort(word) !== null) {
      if (host !== undefined) throw usage(`two hosts (${host}, ${word})`);
      host = word;
    } else {
      throw usage(`${word} is neither a 12-digit join code nor host:port`);
    }
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(host === undefined ? {} : { host }),
    ...(role === undefined ? {} : { role }),
    ...(choice.cli === undefined ? {} : { agent: choice.cli }),
    ...(view === undefined ? {} : { view }),
    ...(repo === undefined ? {} : { repo }),
    ...(device === undefined ? {} : { device }),
    ...(method === undefined ? {} : { submit: method }),
    ...(flags.switches.has("manual") ? { manual: true } : {}),
    ...(notes.length === 0 ? {} : { notes }),
  };
}
