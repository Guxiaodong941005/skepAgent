import type { SkillSource } from "../../core/skills/schemas.js";

/** D36: selecting generic is equivalent to leaving skills off. */
export const generic: SkillSource = {
  manifest: {
    schema: "skep.skill/v1",
    id: "generic",
    name: "Generic",
    version: "1.0.0",
    description: "The standard Skep refine, dispatch and synthesis workflow.",
    master: { guidance: "master.md", synthesis: "synthesis.md" },
    roles: [],
    stages: [],
  },
  files: { "master.md": "", "synthesis.md": "" },
};
