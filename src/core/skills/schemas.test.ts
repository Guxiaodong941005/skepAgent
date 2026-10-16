import { describe, expect, it } from "vitest";
import { SkillManifestSchema, validateSkill } from "./schemas.js";

const manifest = () => ({
  schema: "skep.skill/v1",
  id: "test-skill",
  name: "Test",
  version: "1.0.0",
  description: "Test bundle",
  master: { guidance: "master.md", synthesis: "synthesis.md", contract: "contract.md" },
  roles: [{ id: "api", label: "API", guidance: "api.md" }],
  stages: [{ id: "provider", roles: ["api"], after: [] }],
});
const files = () => ({
  "master.md": "guide",
  "synthesis.md": "check",
  "contract.md": "contract",
  "api.md": "role",
});

describe("skill schema (D36)", () => {
  it("accepts a strict manifest and defaults optional lists", () => {
    expect(SkillManifestSchema.parse(manifest()).roles[0]).toMatchObject({
      required: false,
      match: { roles: [], repos: [] },
    });
  });
  it.each([
    { ...manifest(), id: "../bad" },
    { ...manifest(), command: "run" },
    { ...manifest(), roles: [{ ...manifest().roles[0], unknown: true }] },
    { ...manifest(), roles: [...manifest().roles, ...manifest().roles] },
    { ...manifest(), stages: [{ id: "bad", roles: ["missing"] }] },
    { ...manifest(), stages: [{ id: "bad", roles: [], after: ["missing"] }] },
    {
      ...manifest(),
      stages: [
        { id: "a", roles: [], after: ["b"] },
        { id: "b", roles: [], after: ["a"] },
      ],
    },
    { ...manifest(), stages: [{ id: "a", roles: [], after: ["a"] }] },
    { ...manifest(), master: { guidance: "../outside", synthesis: "synthesis.md" } },
    {
      ...manifest(),
      roles: Array.from({ length: 17 }, (_, n) => ({
        id: `r${n}`,
        label: "role",
        guidance: "role.md",
      })),
    },
    { ...manifest(), artifacts: { contract: { max_chars: 3001 } } },
  ])("rejects invalid structure %#", (value) => {
    expect(SkillManifestSchema.safeParse(value).success).toBe(false);
  });
  it("enforces each file cap and total refine composition budget", () => {
    expect(() =>
      validateSkill({ manifest: manifest(), files: { ...files(), "master.md": "x".repeat(6001) } }),
    ).toThrow("6000");
    expect(() =>
      validateSkill({
        manifest: manifest(),
        files: { ...files(), "contract.md": "x".repeat(3001) },
      }),
    ).toThrow("3000");
    expect(() =>
      validateSkill({ manifest: manifest(), files: { ...files(), "api.md": "x".repeat(1501) } }),
    ).toThrow("1500");
    const roles = Array.from({ length: 6 }, (_, n) => ({
      id: `r${n}`,
      label: "Role",
      guidance: `r${n}.md`,
    }));
    expect(() =>
      validateSkill({
        manifest: { ...manifest(), roles, stages: [] },
        files: {
          ...files(),
          "master.md": "x".repeat(6000),
          "contract.md": "x".repeat(3000),
          ...Object.fromEntries(roles.map((r) => [r.guidance, "x".repeat(1500)])),
        },
      }),
    ).toThrow("16000");
    expect(() => validateSkill({ manifest: manifest(), files: {} })).toThrow("missing text file");
  });
});
