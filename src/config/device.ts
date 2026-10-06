import { readFile } from "node:fs/promises";
import { type DeviceConfig, DeviceConfigSchema } from "../core/schemas/config.js";
import { ConfigError, parseTomlConfig } from "./errors.js";

/**
 * `~/.skep/device.toml` (PRD §7.2, §11.5). Trusted local config: the repo allowlist here is the
 * only set of destinations the daemon will fetch or push, so nothing is taken from task text.
 */
export function parseDeviceConfig(text: string, file: string): DeviceConfig {
  return parseTomlConfig(DeviceConfigSchema, text, file);
}

export async function loadDeviceConfig(path: string): Promise<DeviceConfig> {
  return parseDeviceConfig(await readConfigFile(path), path);
}

/**
 * Look up an allowlisted repo by its configured `name` or by URL. A trailing `.git` and trailing
 * slashes are ignored on both sides, so `git@example.com:owner/app` matches the configured
 * `git@example.com:owner/app.git`.
 */
export function findRepo(
  cfg: DeviceConfig,
  nameOrUrl: string,
): { name: string; url: string } | null {
  const wanted = repoKey(nameOrUrl);
  for (const repo of cfg.repos) {
    if (repo.name === nameOrUrl || repoKey(repo.url) === wanted) {
      return { name: repo.name, url: repo.url };
    }
  }
  return null;
}

/** Compare repo refs independent of a trailing `.git` suffix and trailing slashes. */
function repoKey(ref: string): string {
  return ref.replace(/\.git$/i, "").replace(/\/+$/, "");
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(path, null, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
