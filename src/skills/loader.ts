import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseTomlConfig } from "../config/errors.js";
import { bind, digestInput, refineSkillSections } from "../core/skills/compose.js";
import {
  type Skill,
  SkillError,
  SkillIdSchema,
  SkillManifestSchema,
  type SkillScope,
  type SkillSource,
  skillReferences,
  validateSkill,
} from "../core/skills/schemas.js";
import { findSecrets } from "../exec/redact.js";
import { packagedSkills } from "./packaged/index.js";
import type { SkillTrustStore } from "./trust.js";

export interface SkillRoots {
  user?: string;
  project?: string;
}
export interface SkillEntry {
  id: string;
  scope: SkillScope;
  skill: Skill | null;
  reason?: string;
  trusted: boolean;
  shadowed: boolean;
}

export function loadSkillSource(source: SkillSource, scope: SkillScope): Skill {
  // Fixed error text: never echo the offending text or TOML parse excerpt.
  if (findSecrets(JSON.stringify(source)).length > 0)
    throw new SkillError("skill contains secret-like text; remove it before loading");
  const valid = validateSkill(source);
  const skill = {
    ...valid,
    scope,
    digest: createHash("sha256").update(digestInput(valid)).digest("hex"),
  };
  refineSkillSections({ skill, bindings: bind(valid.manifest.roles, []) });
  return skill;
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export class SkillLoader {
  constructor(
    private readonly roots: SkillRoots,
    private readonly trust?: SkillTrustStore,
    private readonly packaged: readonly SkillSource[] = packagedSkills,
  ) {}

  private async disk(root: string, id: string): Promise<Skill> {
    SkillIdSchema.parse(id);
    const rootReal = await realpath(root);
    const dir = await realpath(path.join(root, id));
    if (!contained(rootReal, dir)) throw new SkillError("skill directory escapes its root");
    const read = async (name: string, max: number): Promise<string> => {
      const file = await realpath(path.join(dir, name));
      if (!contained(dir, file)) throw new SkillError("skill file symlink escapes its directory");
      const info = await stat(file);
      if (!info.isFile() || info.size > max * 4)
        throw new SkillError(`${name} exceeds its file budget`);
      const bytes = await readFile(file);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (cause) {
        throw new SkillError(`${name} is not UTF-8`, { cause });
      }
      if (text.length > max) throw new SkillError(`${name} exceeds ${max} characters`);
      if (findSecrets(text).length > 0)
        throw new SkillError("skill contains secret-like text; remove it before loading");
      return text;
    };
    const manifest = parseTomlConfig(
      SkillManifestSchema,
      await read("skill.toml", 16_000),
      "skill.toml",
    );
    if (manifest.id !== id) throw new SkillError("manifest id must match its directory name");
    const files: Record<string, string> = {};
    for (const ref of skillReferences(manifest)) files[ref.path] = await read(ref.path, ref.max);
    return loadSkillSource({ manifest, files }, "project");
  }

  async list(): Promise<SkillEntry[]> {
    const entries: SkillEntry[] = [];
    const add = async (id: string, scope: SkillScope, load: () => Skill | Promise<Skill>) => {
      try {
        const skill = { ...(await load()), scope };
        entries.push({
          id,
          scope,
          skill,
          trusted: scope !== "project" || ((await this.trust?.isTrusted(skill)) ?? false),
          shadowed: false,
        });
      } catch (error) {
        entries.push({
          id,
          scope,
          skill: null,
          reason: error instanceof Error ? error.message : String(error),
          trusted: false,
          shadowed: false,
        });
      }
    };
    for (const scope of ["project", "user"] as const) {
      const root = this.roots[scope];
      if (root === undefined) continue;
      let names: string[];
      try {
        names = (await readdir(root)).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new SkillError(`Cannot list ${scope} skills`, { cause: error });
      }
      for (const id of names) await add(id, scope, () => this.disk(root, id));
    }
    for (const source of this.packaged) {
      const id = SkillManifestSchema.parse(source.manifest).id;
      await add(id, "packaged", () => loadSkillSource(source, "packaged"));
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      entry.shadowed = seen.has(entry.id);
      seen.add(entry.id);
    }
    return entries;
  }

  async get(selection: string, requireTrust = true): Promise<Skill> {
    const [scope, id] = selection.includes(":") ? selection.split(":") : [undefined, selection];
    if (
      selection.split(":").length > 2 ||
      id === undefined ||
      !SkillIdSchema.safeParse(id).success ||
      (scope !== undefined && !["project", "user", "packaged"].includes(scope))
    )
      throw new SkillError("use a skill id or scope:id");
    const entry = (await this.list()).find(
      (e) => e.id === id && (scope === undefined || e.scope === scope),
    );
    if (!entry) throw new SkillError(`unknown skill ${selection}; run /skills`);
    if (!entry.skill) throw new SkillError(`skill ${selection} is invalid: ${entry.reason}`);
    if (requireTrust && !entry.trusted)
      throw new SkillError(
        `project skill ${id} is untrusted; review /skill show ${selection}, then /skill trust ${selection}`,
      );
    return entry.skill;
  }
}
