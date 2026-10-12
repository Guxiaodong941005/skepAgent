/**
 * Well-known paths under `SKEP_HOME` (ARCHITECTURE §3, §7, §12).
 *
 * Resolution order for the home directory is `--home` (applied by the CLI before calling
 * `skepPaths`) then `SKEP_HOME` then `~/.skep/projects/<projectId>`.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execFileChecked } from "../util/exec.js";

const ProjectRootSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && !value.includes("\0"));

export class ProjectRootError extends Error {
  constructor(cwd: string, options: ErrorOptions) {
    super(
      `Unable to resolve project root from ${cwd}; check the directory and Git access, ` +
        "or set SKEP_HOME / --home explicitly",
      options,
    );
    this.name = "ProjectRootError";
  }
}

/** Canonical checkout root; directories outside a Git work tree use their own realpath. */
export async function resolveProjectRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const canonicalCwd = await realpath(cwd);
    // GIT_DIR / GIT_WORK_TREE must not make an unrelated checkout choose this project's home.
    const gitEnv: Record<string, string> = { LC_ALL: "C" };
    for (const key of ["PATH", "HOME"]) {
      const value = env[key];
      if (value !== undefined) gitEnv[key] = value;
    }
    const result = await execFileChecked("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalCwd,
      env: gitEnv,
      allowFailure: true,
    });
    if (result.code !== 0) {
      if (
        result.code === 128 &&
        /not a git repository|must be run in a work tree/.test(result.stderr)
      ) {
        return canonicalCwd;
      }
      throw new Error(result.stderr.trim() || "git rev-parse failed");
    }
    const root = ProjectRootSchema.parse(result.stdout.replace(/\r?\n$/, ""));
    return await realpath(root);
  } catch (cause) {
    throw new ProjectRootError(cwd, { cause });
  }
}

/** Stable path identity, independent of repo routing labels and checkout basenames. */
export function projectId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/** Explicit homes stay exact; only the default is scoped to the canonical project root. */
export async function skepHome(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<string> {
  const fromEnv = env.SKEP_HOME;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const root = await resolveProjectRoot(cwd, env);
  const userHome = env.HOME || os.homedir();
  return path.join(userHome, ".skep", "projects", projectId(root));
}

export interface SkepPaths {
  /** Root of all local Skep state. */
  home: string;
  /** `device.toml` (PRD §7.2). */
  deviceToml: string;
  /** Local trust root. Never the copy inside the blackboard repo (PRD §11.2). */
  allowedSigners: string;
  /** Unix socket the CLI uses to talk to `skepd` (ARCHITECTURE §12). */
  socket: string;
  /** Single-daemon lock file (ARCHITECTURE §3). */
  lockFile: string;
  /** Daemon-owned private blackboard clone (ARCHITECTURE §7.1). */
  blackboardClone: string;
  /** CLI fallback clone, used only when the daemon is down (ARCHITECTURE §3). */
  cliBlackboardClone: string;
  /** Directory holding the device's SSH signing keys. */
  keysDir: string;
}

/** Absolute paths for the files a device keeps under `home`. */
export function skepPaths(home: string): SkepPaths {
  const root = path.resolve(home);
  return {
    home: root,
    deviceToml: path.join(root, "device.toml"),
    allowedSigners: path.join(root, "allowed_signers"),
    socket: path.join(root, "skepd.sock"),
    lockFile: path.join(root, "skepd.lock"),
    blackboardClone: path.join(root, "blackboard"),
    cliBlackboardClone: path.join(root, "cli-blackboard"),
    keysDir: path.join(root, "keys"),
  };
}
