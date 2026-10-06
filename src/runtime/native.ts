import { type ChildProcess, execFile, spawn } from "node:child_process";
import { type FileHandle, open, readdir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { type Clock, systemClock } from "../util/clock.js";
import type { ProcessExit, ProcessHandle, RuntimeBackend, SpawnOptions } from "./types.js";

export class NativeRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeRuntimeError";
  }
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    throw new NativeRuntimeError(`Expected a positive OS process id, received ${pid}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function procStat(stat: string, pid: number): { token: string; pgid: number; state: string } {
  // ARCHITECTURE §10.1: field 22, counting after comm's last ')'. Linux permits spaces,
  // parentheses and newlines in comm, so splitting the entire stat record is unsafe.
  const prefix = `${pid} (`;
  const end = stat.lastIndexOf(")");
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const token = fields[19];
  const pgid = fields[2];
  const state = fields[0];
  if (
    !stat.startsWith(prefix) ||
    end < prefix.length ||
    !token ||
    !/^\d+$/.test(token) ||
    !pgid ||
    !/^\d+$/.test(pgid) ||
    !state ||
    !/^[A-Za-z]$/.test(state)
  ) {
    throw new NativeRuntimeError(
      `Malformed /proc/${pid}/stat: expected process state, group and start time ` +
        `(pid matches: ${stat.startsWith(prefix)}, fields: ${fields.length}, ` +
        `state valid: ${Boolean(state && /^[A-Za-z]$/.test(state))}, ` +
        `group valid: ${Boolean(pgid && /^\d+$/.test(pgid))}, ` +
        `start valid: ${Boolean(token && /^\d+$/.test(token))})`,
    );
  }
  return { token, pgid: Number(pgid), state };
}

/** Missing processes have no token; unreadable or malformed process metadata is an error. */
export async function readStartToken(pid: number): Promise<string | null> {
  assertPid(pid);
  const os = platform();
  switch (os) {
    case "linux": {
      let stat: string;
      try {
        stat = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
        throw new NativeRuntimeError(`Cannot read /proc/${pid}/stat for the start token`, {
          cause: error,
        });
      }
      // A proc file opened before exit can produce an empty read after its task disappears.
      return stat === "" ? null : procStat(stat, pid).token;
    }
    case "darwin":
      return new Promise((resolve, reject) => {
        // A fixed locale/timezone makes lstart comparable across daemon restarts (§10.1).
        execFile(
          "/bin/ps",
          ["-o", "lstart=", "-p", String(pid)],
          { shell: false, env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" },
          (error, stdout, stderr) => {
            const token = stdout.trim().replace(/\s+/g, " ");
            if (error) {
              // ps exits 1 with no output when the process disappeared between observations.
              if (error.code === 1 && token === "" && stderr.trim() === "") {
                resolve(null);
              } else {
                reject(
                  new NativeRuntimeError(`Cannot read the start token for process ${pid} with ps`, {
                    cause: error,
                  }),
                );
              }
              return;
            }
            if (token === "") {
              resolve(null);
            } else if (
              /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(token)
            ) {
              resolve(token);
            } else {
              reject(new NativeRuntimeError(`Malformed ps start time for process ${pid}`));
            }
          },
        );
      });
    default:
      throw new NativeRuntimeError(`Native runtime requires Linux or macOS, received ${os}`);
  }
}

function signalGroup(pgid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    // Exiting between wait/timeout and signalling is normal; other failures require attention.
    if (errorCode(error) === "ESRCH") return;
    throw new NativeRuntimeError(`Cannot send ${signal} to process group ${pgid}`, {
      cause: error,
    });
  }
}

/** The native I/O boundary; callers inject this RuntimeBackend into adapters and checks. */
export class NativeRuntime implements RuntimeBackend {
  readonly name = "native";
  private readonly clock: Clock;

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  private async groupRunning(pgid: number): Promise<boolean> {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false;
      if (errorCode(error) !== "EPERM") {
        throw new NativeRuntimeError(`Cannot inspect process group ${pgid}`, { cause: error });
      }
    }

    if (platform() === "linux") {
      let names: string[];
      try {
        names = await readdir("/proc");
      } catch (error) {
        throw new NativeRuntimeError(`Cannot inspect /proc for process group ${pgid}`, {
          cause: error,
        });
      }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        let text: string;
        try {
          text = await readFile(`/proc/${name}/stat`, "utf8");
        } catch (error) {
          if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") continue;
          throw new NativeRuntimeError(
            `Cannot inspect /proc/${name}/stat for process group ${pgid}`,
            { cause: error },
          );
        }
        if (text === "") continue;
        const proc = procStat(text, Number(name));
        // Killed orphans may remain zombies until init reaps them; they cannot do any work.
        if (proc.pgid === pgid && !["Z", "X", "x"].includes(proc.state)) return true;
      }
      return false;
    }

    return new Promise((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-axo", "pgid=,stat="],
        { shell: false, env: { LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" },
        (error, stdout) => {
          if (error) {
            reject(
              new NativeRuntimeError(`Cannot inspect process group ${pgid} with ps`, {
                cause: error,
              }),
            );
            return;
          }
          let alive = false;
          for (const line of stdout.trim().split("\n")) {
            if (line.trim() === "") continue;
            const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
            if (!match?.[1] || !match[2]) {
              reject(new NativeRuntimeError(`Malformed ps status for process group ${pgid}`));
              return;
            }
            if (Number(match[1]) === pgid && !match[2].startsWith("Z")) alive = true;
          }
          resolve(alive);
        },
      );
    });
  }

  private async waitForGroup(pgid: number, exit: ProcessExit): Promise<ProcessExit> {
    // PRD §9.7 requires the entire group to stop before checkpointing. A leader can exit on
    // SIGINT while its children ignore it, so a leader-only wait would skip escalation.
    while (await this.groupRunning(pgid)) await this.clock.sleep(25);
    return exit;
  }

  async spawn(opts: SpawnOptions): Promise<ProcessHandle> {
    const os = platform();
    if (os !== "linux" && os !== "darwin") {
      throw new NativeRuntimeError(`Native runtime requires Linux or macOS, received ${os}`);
    }

    let log: FileHandle;
    try {
      log = await open(opts.logPath, "a", 0o600);
    } catch (error) {
      throw new NativeRuntimeError(`Cannot open runtime log ${opts.logPath}`, { cause: error });
    }

    try {
      let child: ChildProcess;
      try {
        child = spawn(opts.argv[0], opts.argv.slice(1), {
          detached: true,
          shell: false,
          cwd: opts.cwd,
          // D19: the caller's sanitized environment is complete; never merge process.env.
          env: opts.env,
          uid: opts.uid,
          gid: opts.gid,
          stdio: ["pipe", log.fd, log.fd],
        });
      } catch (error) {
        throw new NativeRuntimeError(`Cannot spawn ${opts.argv[0]} in ${opts.cwd}`, {
          cause: error,
        });
      }

      // Capture completion before any await: a fast check can exit while its token is read.
      const leaderExit = new Promise<ProcessExit>((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => {
          reject(
            new NativeRuntimeError(`Runtime process ${opts.argv[0]} failed`, { cause: error }),
          );
        });
        child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
          // Early exit closes the pipe; preserve that process's actual exit status.
          if (error.code !== "EPIPE") {
            reject(
              new NativeRuntimeError(`Cannot write stdin for ${opts.argv[0]}`, { cause: error }),
            );
          }
        });
      });
      const completion = leaderExit.then((exit) => {
        const pid = child.pid;
        if (pid === undefined) {
          throw new NativeRuntimeError(`Exited ${opts.argv[0]} without an OS process id`);
        }
        return this.waitForGroup(pid, exit);
      });
      // Spawn/setup can reject before a caller receives the handle. Observe the rejection here;
      // spawn and wait still report the original error, and every wait shares the same promise.
      void completion.catch(() => undefined);
      const wait = (): Promise<ProcessExit> => completion;

      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => {
          reject(
            new NativeRuntimeError(`Cannot spawn ${opts.argv[0]} in ${opts.cwd}`, { cause: error }),
          );
        });
      });
      const pid = child.pid;
      if (pid === undefined) {
        throw new NativeRuntimeError(`Spawned ${opts.argv[0]} without an OS process id`);
      }

      try {
        const token = await readStartToken(pid);
        if (token === null) {
          // A short-lived check may already have been reaped. An empty token cannot match a
          // future process, so this invocation cannot be re-adopted as a live leader (§10.6).
          if (child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(pid, 0);
              throw new NativeRuntimeError(`Live process ${pid} has no readable start token`);
            } catch (error) {
              if (errorCode(error) !== "ESRCH") throw error;
            }
          }
          // Wait only for the leader here: surviving children must not prevent returning the
          // handle that lets the adapter interrupt them. wait() still waits for the whole group.
          await leaderExit;
        }
        child.stdin?.end(opts.stdin);
        return {
          pid,
          pgid: pid,
          startToken: token ?? "",
          wait,
          signalGroup: (signal) => signalGroup(pid, signal),
        };
      } catch (error) {
        // A failed metadata/stdin setup must not abandon a detached process tree (§10.1).
        signalGroup(pid, "SIGKILL");
        await wait();
        if (error instanceof NativeRuntimeError) throw error;
        throw new NativeRuntimeError(`Cannot supervise runtime process ${pid}`, { cause: error });
      }
    } finally {
      // spawn duplicates the descriptor into the child; the parent must release its copy.
      await log.close();
    }
  }

  async isAlive(pgid: number, startToken: string): Promise<boolean> {
    assertPid(pgid);
    if (startToken === "" || (await readStartToken(pgid)) !== startToken) return false;
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      if (errorCode(error) === "ESRCH") return false;
      if (errorCode(error) === "EPERM") return true;
      throw new NativeRuntimeError(`Cannot inspect process group ${pgid}`, { cause: error });
    }
  }
}
