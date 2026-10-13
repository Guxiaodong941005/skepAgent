/**
 * `device.toml` `[orchestrate] mode`: how free text in the shell is handled
 * (docs/plans/tui-scroll-and-herdr-controller.md §3.5). Default `auto` (locked decision §9.1).
 * Read as loosely as `[agent] cli`: a missing file or key is the default, a bad value a warning.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ConfigError, parseTomlConfig } from "../config/errors.js";
import {
  DEFAULT_ORCHESTRATION_MODE,
  type OrchestrationMode,
} from "../core/orchestration/reducer.js";
import { atomicWrite } from "../util/fs.js";

export const ORCHESTRATION_MODES = [
  "auto",
  "confirm",
  "off",
] as const satisfies readonly OrchestrationMode[];

const OrchestrateSettingSchema = z.object({
  orchestrate: z.object({ mode: z.enum(ORCHESTRATION_MODES) }).optional(),
});

export async function loadOrchestrationMode(
  file: string,
  warn: (message: string) => void = () => {},
): Promise<OrchestrationMode> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_ORCHESTRATION_MODE;
    throw error;
  }
  try {
    return (
      parseTomlConfig(OrchestrateSettingSchema, text, file).orchestrate?.mode ??
      DEFAULT_ORCHESTRATION_MODE
    );
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    warn(
      `ignoring the [orchestrate] setting (${error.message}); using ${DEFAULT_ORCHESTRATION_MODE}`,
    );
    return DEFAULT_ORCHESTRATION_MODE;
  }
}

/** Sets `[orchestrate] mode`, keeping every other line of the file as it was. */
export async function saveOrchestrationMode(file: string, mode: OrchestrationMode): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const entry = `mode = "${mode}"`;
  const header = lines.findIndex((line) => /^\s*\[orchestrate\]\s*(#.*)?$/.test(line));
  if (header < 0) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push("[orchestrate]", entry);
  } else {
    let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
    const key = lines.findIndex((line, i) => i > header && i < end && /^\s*mode\s*=/.test(line));
    if (key >= 0) lines[key] = entry;
    else lines.splice(header + 1, 0, entry);
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}
