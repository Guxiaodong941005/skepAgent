import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const ArgSchema = z.string().refine((value) => !value.includes("\0"), "argv contains NUL");
const ArgvSchema = z.tuple([ArgSchema.min(1)]).rest(ArgSchema);
const PidfileSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"));

export class PtyHelperError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PtyHelperError";
  }
}

/** The fixed script command execs this helper, keeping its pid as the PTY's process group. */
export async function runPtyHelper(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let argv: z.infer<typeof ArgvSchema>;
  let pidfile: string;
  try {
    argv = ArgvSchema.parse(JSON.parse(env.SKEP_PTY_ARGV ?? ""));
    pidfile = PidfileSchema.parse(env.SKEP_PTY_PIDFILE);
  } catch (cause) {
    throw new PtyHelperError("Invalid SKEP_PTY_ARGV or SKEP_PTY_PIDFILE", { cause });
  }

  // Atomic publication keeps the runner from interpreting a partially written pid as a group.
  const pending = `${pidfile}.pending`;
  try {
    writeFileSync(pending, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    renameSync(pending, pidfile);
  } catch (cause) {
    throw new PtyHelperError("Cannot publish the PTY helper pid sidecar", { cause });
  }
  const agentEnv = { ...env };
  for (const key of ["SKEP_PTY_ARGV", "SKEP_PTY_PIDFILE", "SKEP_PTY_NODE", "SKEP_PTY_HELPER"]) {
    delete agentEnv[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env: agentEnv, shell: false, stdio: "inherit" });
    // Stay alive to reap the agent on TERM; the runner signals this entire process group.
    const onTerm = () => {
      // The agent received the same group signal; retain the helper until it can be reaped.
    };
    process.on("SIGTERM", onTerm);
    child.once("error", (cause) => {
      process.removeListener("SIGTERM", onTerm);
      reject(new PtyHelperError(`Cannot start PTY agent ${argv[0]}`, { cause }));
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGTERM", onTerm);
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runPtyHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 125;
  }
}
