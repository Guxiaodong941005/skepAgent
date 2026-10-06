/**
 * Human vs `--machine` output (PRD §14, §15.2).
 *
 * Machine mode prints exactly one JSON line so a wrapper (the herdr human layer) can parse it
 * without scraping prose. The line is `canonicalJson`, not `JSON.stringify`: object keys come
 * out in sorted order, so two runs of the same state print byte-identical output (F20). Human
 * mode writes the supplied text, or `skep: <message>` for errors.
 */

import { canonicalJson } from "../core/canonical.js";

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  rejected: 3,
  notImplemented: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number = EXIT.error) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Stub action: the command parsed and validated, but the behaviour lands in a later task. */
export function notImplemented(commandPath: string): never {
  throw new CliError(
    "not_implemented",
    `${commandPath} is not implemented yet`,
    EXIT.notImplemented,
  );
}

export interface Output {
  readonly machine: boolean;
  /** Success. Machine: one JSON line `{ ok: true, result }`. Human: `human()`. */
  result(data: unknown, human: () => string): void;
  /** Failure. Machine: one JSON line `{ ok: false, error: { code, message } }` on stdout. */
  error(err: CliError): void;
  /**
   * A failure that still has a result to report (G5, SK-402 review note 1).
   *
   * Machine mode prints exactly one line whose top-level `ok` is `false`, so it agrees with a
   * non-zero exit, and carries both the error and the result:
   * `{ ok: false, error: { code, message }, result }`. Human mode prints the result text and then
   * the `skep:` error line on stderr.
   */
  fail(err: CliError, data: unknown, human: () => string): void;
}

export interface OutputStreams {
  write(s: string): void;
}

export function createOutput(opts: {
  machine: boolean;
  stdout: OutputStreams;
  stderr: OutputStreams;
}): Output {
  const { machine, stdout, stderr } = opts;
  return {
    machine,
    result(data, human) {
      if (machine) {
        stdout.write(`${machineLine({ ok: true, result: data })}\n`);
      } else {
        stdout.write(human());
      }
    },
    error(err) {
      if (machine) {
        // One line on stdout, nothing on stderr: wrappers read a single stream.
        stdout.write(`${machineLine(errorBody(err))}\n`);
      } else {
        stderr.write(`skep: ${err.message}\n`);
      }
    },
    fail(err, data, human) {
      if (machine) {
        stdout.write(`${machineLine({ ...errorBody(err), result: data })}\n`);
      } else {
        stdout.write(human());
        stderr.write(`skep: ${err.message}\n`);
      }
    },
  };
}

/**
 * One canonical machine line (F20). `undefined` array entries become `null`: `canonicalJson`
 * rejects them, and a machine line must always print rather than throw on a sparse payload.
 */
function machineLine(value: unknown): string {
  return canonicalJson(nullifyHoles(value));
}

function nullifyHoles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => nullifyHoles(entry ?? null));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = nullifyHoles(entry);
    }
    return out;
  }
  return value;
}

/** The `{ ok: false, error }` object shared by {@link Output.error} and {@link Output.fail}. */
function errorBody(err: CliError): {
  ok: false;
  error: { code: string; message: string };
} {
  return { ok: false, error: { code: err.code, message: err.message } };
}
