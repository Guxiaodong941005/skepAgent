import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Skill } from "../core/skills/schemas.js";
import { SkillError } from "../core/skills/schemas.js";
import { atomicWrite } from "../util/fs.js";

const TrustSchema = z.strictObject({
  version: z.literal(1),
  digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
});

/** D36: project prompt text needs explicit trust again after any content change. */
export class SkillTrustStore {
  private writes: Promise<void> = Promise.resolve();
  readonly file: string;
  constructor(home: string) {
    this.file = path.join(home, "skills-trust.json");
  }
  private async read(): Promise<z.infer<typeof TrustSchema>> {
    try {
      return TrustSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, digests: [] };
      throw new SkillError("Cannot read skills-trust.json; fix or remove the invalid trust store", {
        cause,
      });
    }
  }
  async isTrusted(skill: Skill): Promise<boolean> {
    return skill.scope !== "project" || (await this.read()).digests.includes(skill.digest);
  }
  async trust(skill: Skill): Promise<void> {
    if (skill.scope !== "project") return;
    const write = this.writes.then(async () => {
      const record = await this.read();
      if (!record.digests.includes(skill.digest)) record.digests.push(skill.digest);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}
