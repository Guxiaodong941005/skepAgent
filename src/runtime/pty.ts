import { spawn } from "node:child_process";
import { constants, watch } from "node:fs";
import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Clock } from "../util/clock.js";
import type { ProcessExit } from "./types.js";

export interface PtyRunOptions {
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  transcriptPath: string;
  input: "inherit" | string;
  signal?: AbortSignal;
  clock: Clock;
  graceMs?: number;
}

export interface PtyRunResult {
  exit: ProcessExit;
  aborted: boolean;
  /** Unredacted raw terminal bytes, for the local journal only (ARCHITECTURE D19, D27). */
  transcript: Buffer;
}

export interface PtyRunner {
  run(opts: PtyRunOptions): Promise<PtyRunResult>;
}

export class PtyUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PtyUnavailableError";
  }
}

export class PtyRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PtyRunError";
  }
}

const LINUX_COMMAND = 'exec "$SKEP_PTY_NODE" "$SKEP_PTY_HELPER"';
const PidSchema = z
  .string()
  .regex(/^[1-9][0-9]*\n?$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new PtyRunError(`Cannot send ${signal} to PTY process group ${pid}`, { cause });
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new PtyRunError(`Cannot inspect PTY process group ${pid}`, { cause });
  }
}

function transcriptBody(raw: Buffer): Buffer {
  // Latin-1 is a byte-preserving view: terminal logs can contain invalid UTF-8.
  const body = raw
    .toString("latin1")
    .replace(/^Script started on [^\n]*(?:\n|$)/, "")
    .replace(/\n?Script done on [^\n]*\n?$/, "");
  return Buffer.from(body, "latin1");
}

export function createPtyRunner(
  deps: { platform?: NodeJS.Platform; scriptPath?: string } = {},
): PtyRunner {
  const platform = deps.platform ?? process.platform;
  const scriptPath = deps.scriptPath ?? "script";
  return {
    async run(opts) {
      if (platform !== "linux" && platform !== "darwin") {
        throw new PtyUnavailableError(`PTY sessions require Linux or macOS, received ${platform}`);
      }
      const graceMs = opts.graceMs ?? 10_000;
      if (!Number.isFinite(graceMs) || graceMs < 0) {
        throw new RangeError("PTY graceMs must be a non-negative finite delay");
      }
      if (opts.signal?.aborted) {
        return { exit: { code: null, signal: null }, aborted: true, transcript: Buffer.alloc(0) };
      }
      const helperPath = fileURLToPath(new URL("./pty-helper.js", import.meta.url));
      try {
        await access(helperPath, constants.R_OK);
      } catch (cause) {
        throw new PtyUnavailableError("Compiled PTY helper is unavailable; build Skep first", {
          cause,
        });
      }
      let sidecarDir: string;
      try {
        const log = await open(
          opts.transcriptPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await log.chmod(0o600);
        } finally {
          await log.close();
        }
        sidecarDir = await mkdtemp(join(dirname(opts.transcriptPath), ".skep-pty-"));
      } catch (cause) {
        throw new PtyRunError("Cannot prepare a private PTY transcript and pid sidecar", { cause });
      }
      const pidfile = join(sidecarDir, "pid");
      let helperPid: number | undefined;
      let scriptPid: number | undefined;
      let aborted = false;
      let escalated = false;
      let abortWork: Promise<void> | undefined;
      let pidRead = Promise.resolve();
      const timer = new AbortController();
      let fail: (error: Error) => void = () => {};
      const failed = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const readPid = async () => {
        if (helperPid !== undefined) return;
        let text: string;
        try {
          text = await readFile(pidfile, "utf8");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
          throw new PtyRunError("Cannot read PTY helper pid", { cause });
        }
        const parsed = PidSchema.safeParse(text);
        if (!parsed.success)
          throw new PtyRunError("Invalid PTY helper pid sidecar", { cause: parsed.error });
        helperPid = parsed.data;
        if (aborted) signalGroup(helperPid, escalated ? "SIGKILL" : "SIGTERM");
      };
      const watcher = watch(sidecarDir, (_event, filename) => {
        if (filename !== null && String(filename) !== basename(pidfile)) return;
        pidRead = pidRead.then(readPid).catch(fail);
      });
      watcher.on("error", (cause) =>
        fail(new PtyRunError("Cannot watch PTY helper pid", { cause })),
      );
      const argv =
        platform === "darwin"
          ? ["-q", opts.transcriptPath, process.execPath, helperPath]
          : ["-q", "-e", "-f", "-c", LINUX_COMMAND, opts.transcriptPath];
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(scriptPath, argv, {
          cwd: opts.cwd,
          env: {
            ...opts.env,
            SKEP_PTY_NODE: process.execPath,
            SKEP_PTY_HELPER: helperPath,
            SKEP_PTY_ARGV: JSON.stringify(opts.argv),
            SKEP_PTY_PIDFILE: pidfile,
          },
          shell: false,
          detached: true,
          stdio: opts.input === "inherit" ? "inherit" : "pipe",
        });
      } catch (cause) {
        watcher.close();
        await rm(sidecarDir, { recursive: true, force: true });
        throw new PtyUnavailableError(`Cannot start ${scriptPath} for a PTY session`, { cause });
      }
      scriptPid = child.pid;
      const closed = new Promise<ProcessExit>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.once("error", (cause) =>
        fail(new PtyUnavailableError(`Cannot start ${scriptPath} for a PTY session`, { cause })),
      );
      child.stdout?.resume();
      child.stderr?.resume();
      child.stdin?.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EPIPE") fail(new PtyRunError("Cannot write PTY input", { cause }));
      });
      if (opts.input !== "inherit") child.stdin?.end(opts.input);

      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        abortWork = (async () => {
          if (helperPid !== undefined) signalGroup(helperPid, "SIGTERM");
          if (scriptPid !== undefined) signalGroup(scriptPid, "SIGTERM");
          const slept = opts.clock.sleep(graceMs, timer.signal);
          let groupsExited = false;
          try {
            await Promise.race([
              slept,
              closed.then(async () => {
                await pidRead;
                await readPid();
                // script can exit while TERM-trapping agent descendants still own the PTY.
                if (helperPid === undefined || groupExists(helperPid)) await slept;
                else groupsExited = true;
              }),
            ]);
          } finally {
            timer.abort();
          }
          if (groupsExited) return;
          escalated = true;
          await readPid();
          if (helperPid !== undefined) signalGroup(helperPid, "SIGKILL");
          if (scriptPid !== undefined) signalGroup(scriptPid, "SIGKILL");
        })();
        void abortWork.catch(fail);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
      try {
        const exit = await Promise.race([closed, failed]);
        await pidRead;
        await readPid();
        if (abortWork) await Promise.race([abortWork, failed]);
        if (helperPid === undefined && !aborted) {
          throw new PtyUnavailableError(
            `PTY helper did not start (script exited ${exit.code ?? exit.signal})`,
          );
        }
        const transcript = transcriptBody(await readFile(opts.transcriptPath));
        await writeFile(opts.transcriptPath, transcript, { mode: 0o600 });
        return { exit, aborted, transcript };
      } catch (error) {
        if (helperPid !== undefined) signalGroup(helperPid, "SIGKILL");
        if (scriptPid !== undefined) signalGroup(scriptPid, "SIGKILL");
        await closed;
        if (error instanceof PtyUnavailableError || error instanceof PtyRunError) throw error;
        throw new PtyRunError("Cannot complete the PTY session or save its transcript", {
          cause: error,
        });
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        timer.abort();
        watcher.close();
        await rm(sidecarDir, { recursive: true, force: true });
      }
    },
  };
}

/** Terminal controls are removed only for summaries; the local journal retains raw bytes. */
export function stripTerminalControls(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC uses literal terminal control bytes.
  const osc = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: DCS uses literal terminal control bytes.
  const dcs = /(?:\x1bP|\x90)[\s\S]*?(?:\x1b\\|\x9c|$)/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CSI uses literal terminal control bytes.
  const csi = /(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Other escape commands are terminal controls.
  const escapes = /\x1b[ -/]*[@-~]/g;
  const plain = text
    .replace(osc, "")
    .replace(dcs, "")
    .replace(csi, "")
    .replace(escapes, "")
    .replace(/\r/g, "");
  const output: string[] = [];
  for (const character of plain) {
    if (character === "\b") {
      if (output.at(-1) !== "\n") output.pop();
    } else output.push(character);
  }
  return output.join("");
}
