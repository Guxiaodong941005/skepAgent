import { describe, expect, it } from "vitest";
import { bind, bindingTable, digestInput, refineSkillSections, stageOrder } from "./compose.js";
import { type Skill, SkillManifestSchema } from "./schemas.js";

const roles = SkillManifestSchema.parse({
  schema: "skep.skill/v1",
  id: "test-skill",
  name: "Test",
  version: "1.0.0",
  description: "test",
  master: { guidance: "master.md", synthesis: "synthesis.md" },
  roles: [
    {
      id: "api",
      label: "API",
      required: true,
      guidance: "api.md",
      match: { roles: ["backend"], repos: ["*-api"] },
    },
  ],
}).roles;
const peers = [
  { peerId: "first", device: "one", repo: "test-api", role: "coding", protocolVersion: 1 },
  { peerId: "second", device: "two", repo: "other", role: "BACKEND", protocolVersion: 2 },
  { peerId: "third", device: "three", repo: "last", role: "api", protocolVersion: 2 },
];
describe("pure skill composition", () => {
  it("binds manual > case-insensitive role/alias > repo glob, flagging ties", () => {
    expect(bind(roles, peers)[0]).toMatchObject({
      peerId: "second",
      source: "role",
      candidates: 2,
    });
    expect(bind(roles, peers, { api: "test-api" })[0]).toMatchObject({
      peerId: "first",
      source: "manual",
    });
    expect(bind(roles, peers.slice(0, 1))[0]).toMatchObject({ peerId: "first", source: "repo" });
    expect(bind(roles, peers, { api: null })[0]).toMatchObject({ peerId: null, source: "manual" });
    expect(bind(roles, peers, { api: "disconnected" })[0]?.repo).toBeNull();
    expect(
      bind(
        roles,
        peers.map((p, n) => ({ ...p, joinedAtMs: 100 - n })),
      )[0]?.peerId,
    ).toBe("third");
  });
  it("produces deterministic canonical digest input independent of key order", () => {
    const manifest = SkillManifestSchema.parse({
      schema: "skep.skill/v1",
      id: "test-skill",
      name: "Test",
      version: "1.0.0",
      description: "test",
      master: { guidance: "a", synthesis: "b" },
    });
    expect(digestInput({ manifest, files: { a: "1", b: "2" } })).toBe(
      digestInput({ files: { b: "2", a: "1" }, manifest }),
    );
    expect(JSON.stringify(bind(roles, peers))).toBe(JSON.stringify(bind(roles, peers)));
  });
  it("topologically orders stages, including declarations out of order", () => {
    const stages = [
      { id: "clients", roles: [], after: ["providers"] },
      { id: "providers", roles: [], after: ["contract"] },
      { id: "contract", roles: [], after: [] },
    ];
    expect(stageOrder(stages).map((s) => s.id)).toEqual(["contract", "providers", "clients"]);
    expect(() => stageOrder([{ id: "a", roles: [], after: ["a"] }])).toThrow("DAG");
  });
  it("renders candidate and v1 warnings and caps composed text", () => {
    const manifest = SkillManifestSchema.parse({
      schema: "skep.skill/v1",
      id: "test-skill",
      name: "Test",
      version: "1.0.0",
      description: "test",
      master: { guidance: "master.md", synthesis: "synthesis.md" },
      roles,
    });
    const skill: Skill = {
      manifest,
      scope: "packaged",
      digest: "a".repeat(64),
      files: { "master.md": "guide", "api.md": "role" },
    };
    expect(bindingTable({ skill, bindings: bind(roles, peers) })).toContain("(2 candidates)");
    expect(bindingTable({ skill, bindings: bind(roles, peers, { api: "first" }) })).toContain(
      "brief cut at 4000",
    );
    expect(refineSkillSections({ skill, bindings: bind(roles, peers) })).toContain("ACTIVE SKILL");
    expect(() =>
      refineSkillSections({
        skill: { ...skill, files: { "master.md": "x".repeat(16001) } },
        bindings: [],
      }),
    ).toThrow("16000");
  });
});
