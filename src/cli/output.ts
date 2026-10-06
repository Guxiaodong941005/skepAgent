/**
 * Human vs `--machine` output (PRD §14, §15.2).
 *
 * Machine mode prints exactly one JSON line so a wrapper (the herdr human layer) can parse it
 * without scraping prose. Human mode writes the supplied text, or `skep: <message>` for errors.
 */

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
        stdout.write(`${JSON.stringify({ ok: true, result: data })}\n`);
      } else {
        stdout.write(human());
      }
    },
    error(err) {
      if (machine) {
        // One line on stdout, nothing on stderr: wrappers read a single stream.
        stdout.write(
          `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n`,
        );
      } else {
        stderr.write(`skep: ${err.message}\n`);
      }
    },
  };
}
