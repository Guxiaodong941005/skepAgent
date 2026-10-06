/**
 * Argument parsers shared by the command modules. Failures throw `InvalidArgumentError`, which
 * Commander turns into a usage error (exit 2) whose message names the bad value.
 */

import { InvalidArgumentError } from "commander";
import { AGENT_ID_RE, DEVICE_RE, ITEM_ID_RE, TASK_ID_RE } from "../core/ids.js";

/**
 * The message names both the argument and the bad value: Commander wraps it as
 * `command-argument value '<value>' is invalid for argument '<name>'. <message>`, and `runCli`
 * surfaces that whole string with exit code 2.
 */
function reject(label: string, value: string, expected: string): never {
  throw new InvalidArgumentError(`invalid ${label} '${value}' (expected ${expected})`);
}

export function parseTaskId(value: string): string {
  if (!TASK_ID_RE.test(value)) reject("task id", value, "T-<yyyymmdd>-<4 hex>");
  return value;
}

export function parseItemId(value: string): string {
  if (!ITEM_ID_RE.test(value)) reject("item id", value, "W<n>, e.g. W1");
  return value;
}

export function parseAgentId(value: string): string {
  if (!AGENT_ID_RE.test(value)) reject("agent id", value, "<device>.<role>[.<n>]");
  return value;
}

export function parseDeviceName(value: string): string {
  if (!DEVICE_RE.test(value)) reject("device name", value, "lowercase letters, digits, hyphens");
  return value;
}

/** Positive integer (`--epoch`, `--version`, `--steps`). Zero and negatives are rejected. */
export function parsePositiveInt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError(`invalid positive integer '${value}'`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(`invalid positive integer '${value}'`);
  }
  return n;
}

/** `--seed` may be 0 (a seed, not a count) but must be a non-negative integer. */
export function parseNonNegativeInt(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError(`invalid non-negative integer '${value}'`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(`invalid non-negative integer '${value}'`);
  }
  return n;
}
