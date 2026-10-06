/**
 * Well-known paths under `SKEP_HOME` (ARCHITECTURE §3, §7, §12).
 *
 * Resolution order for the home directory is `--home` (applied by the CLI before calling
 * `skepPaths`) then `SKEP_HOME` then `~/.skep`. Nothing here touches the filesystem.
 */

import os from "node:os";
import path from "node:path";

/** `SKEP_HOME` if set and non-empty, otherwise `~/.skep`. */
export function skepHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SKEP_HOME;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return path.join(os.homedir(), ".skep");
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
