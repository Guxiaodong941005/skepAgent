import { type ExecFileException, execFile } from "node:child_process";

/**
 * Checked `execFile` wrapper (ARCHITECTURE §2 `util/exec.ts`, AGENTS.md subprocess rules).
 *
 * Always `shell: false`: arguments are never interpreted by a shell. `env` is passed exactly as
 * given — there is no implicit `process.env` merge — so a caller that wants a variable must list
 * it. A missing `env` therefore means an empty environment, not the parent's.
 */

export interface ExecOptions {
  cwd?: string;
  /** Passed as-is. No implicit merge with `process.env`. */
  env?: Record<string, string>;
  input?: string | Uint8Array;
  /** Kills the child once exceeded. Defaults to 120 s. */
  timeoutMs?: number;
  /**
   * Per-stream cap, applied by Node to stdout and stderr separately (not to their sum).
   * Defaults to 16 MiB. Overflow is a failure, returned instead of thrown when `allowFailure`.
   */
  maxBufferBytes?: number;
  /** Return a non-zero exit, signal, timeout or buffer overflow as a result instead of throwing. */
  allowFailure?: boolean;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export class ExecError extends Error {
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly result: ExecResult,
    options?: ErrorOptions,
  ) {
    super(describeFailure(file, args, result), options);
    this.name = "ExecError";
  }
}

/** Why a child failed, in priority order so a timeout is not reported as a generic signal. */
function describeFailure(file: string, args: string[], result: ExecResult): string {
  const command = [file, ...args].join(" ");
  if (result.timedOut) return `${command} timed out`;
  if (result.signal !== null) return `${command} killed by ${result.signal}`;
  if (result.code !== null && result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return detail === ""
      ? `${command} exited ${result.code}`
      : `${command} exited ${result.code}: ${detail}`;
  }
  return `${command} failed`;
}

/**
 * Node's `ExecException` carries the exit status and any buffered output on the error itself.
 * A timeout sets `killed` and `signal === killSignal` (SIGTERM here); a child that dies of a
 * signal on its own leaves `killed` false, so the two stay distinguishable.
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is the overflow: the child did run, so unlike a spawn
 * failure it is a result `allowFailure` may return. Any other string `code` is a spawn or abort
 * failure, which has no exit status.
 */
function isBufferOverflow(error: ExecFileException): boolean {
  return error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function fromException(error: ExecFileException, stdout: string, stderr: string): ExecResult {
  const code = typeof error.code === "number" ? error.code : null;
  const signal = typeof error.signal === "string" ? error.signal : null;
  return {
    code,
    signal,
    // Node delivers captured output through the callback arguments. The copies on the error
    // object are only populated for some failure modes (buffer overflow), so the arguments win.
    stdout: stdout || stringify(error.stdout),
    stderr: stderr || stringify(error.stderr),
    timedOut: error.killed === true && signal === "SIGTERM",
  };
}

function stringify(output: string | Buffer | undefined): string {
  if (output === undefined) return "";
  return typeof output === "string" ? output : output.toString("utf8");
}

/**
 * Runs `file` with `args`. Throws {@link ExecError} on a non-zero exit, a signal, a timeout or a
 * buffer overflow unless `allowFailure` is set, in which case the result is returned instead.
 * Spawn failures (missing binary, `cwd` gone, abort) always throw: there is no result to return.
 *
 * Stdin is always closed. With `input` that payload is written first; without it the child sees
 * an immediate EOF, so a command that reads stdin until EOF (trusted checks, SK-502) cannot block
 * until the timeout.
 */
export function execFileChecked(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? {},
        shell: false,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        signal: opts.signal,
        // SIGTERM is what Node uses to mark a timeout (`killed` + this signal). A caller that
        // needs a harder stop owns the AbortSignal and kills the process group itself (SK-306).
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, signal: null, stdout, stderr, timedOut: false });
          return;
        }
        // A string `code` other than the buffer-overflow code is a spawn/abort failure: nothing
        // ran to completion, so there is no result for `allowFailure` to return.
        if (typeof error.code === "string" && !isBufferOverflow(error)) {
          reject(new ExecError(file, args, fromException(error, stdout, stderr), { cause: error }));
          return;
        }
        const result = fromException(error, stdout, stderr);
        if (opts.allowFailure) resolve(result);
        else reject(new ExecError(file, args, result, { cause: error }));
      },
    );
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // A child that exits before reading stdin surfaces its real failure in the close callback.
      if (error.code !== "EPIPE") {
        reject(
          new ExecError(
            file,
            args,
            { code: null, signal: null, stdout: "", stderr: error.message, timedOut: false },
            { cause: error },
          ),
        );
      }
    });
    // Close stdin either way. Leaving it open makes a child that reads until EOF block until
    // `timeoutMs` (review: `cat` with no input timed out instead of exiting).
    child.stdin?.end(opts.input);
  });
}
