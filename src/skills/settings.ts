import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseTomlConfig } from "../config/errors.js";
import { resolveProjectRoot } from "../config/paths.js";
import { SkillError, SkillIdSchema } from "../core/skills/schemas.js";
import { atomicWrite } from "../util/fs.js";
import { SkillLoader, type SkillRoots } from "./loader.js";
import { SkillTrustStore } from "./trust.js";

export const SkillSelectionSchema = z.string().refine((value) => {
  const parts = value.split(":");
  return parts.length === 1
    ? SkillIdSchema.safeParse(value).success
    : parts.length === 2 &&
        ["packaged", "user", "project"].includes(parts[0] ?? "") &&
        SkillIdSchema.safeParse(parts[1]).success;
}, "use a skill id or scope:id");
const SettingSchema = z.object({
  skill: z.strictObject({ default: SkillSelectionSchema.optional() }).optional(),
});

export async function loadSkillDefault(file: string): Promise<string | null> {
  try {
    return (
      parseTomlConfig(SettingSchema, await readFile(file, "utf8"), "device.toml").skill?.default ??
      null
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function saveSkillDefault(file: string, selection: string | null): Promise<void> {
  if (selection !== null) SkillSelectionSchema.parse(selection);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const header = lines.findIndex((line) => /^\s*\[skill\]\s*(#.*)?$/.test(line));
  const entry = `default = ${JSON.stringify(selection)}`;
  if (header < 0) {
    if (selection !== null) lines.push("", "[skill]", entry);
  } else {
    let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
    const key = lines.findIndex((line, i) => i > header && i < end && /^\s*default\s*=/.test(line));
    if (key >= 0) {
      if (selection === null) lines.splice(key, 1);
      else lines[key] = entry;
    } else if (selection !== null) lines.splice(header + 1, 0, entry);
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export interface SkillEnvironmentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  roots?: SkillRoots;
}
/** Roots are injectable; the fallback never reads provider configuration. */
export async function skillEnvironment(
  options: SkillEnvironmentOptions,
): Promise<{ loader: SkillLoader; trust: SkillTrustStore | null }> {
  const trust = options.home ? new SkillTrustStore(options.home) : null;
  const project =
    options.roots?.project ??
    path.join(await resolveProjectRoot(options.cwd, options.env), ".skep", "skills");
  const user =
    options.roots?.user ??
    options.env.SKEP_SKILLS_HOME ??
    path.join(options.env.HOME || options.env.SKEP_HOME || options.cwd, ".skep", "skills");
  return { loader: new SkillLoader({ project, user }, trust ?? undefined), trust };
}
export function requireSkillFile(file: string | undefined): string {
  if (!file) throw new SkillError("project device.toml is unavailable; configure SKEP_HOME first");
  return file;
}
