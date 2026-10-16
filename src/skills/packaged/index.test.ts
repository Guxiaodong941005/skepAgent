import { describe, expect, it } from "vitest";
import { bind } from "../../core/skills/compose.js";
import { refinePrompt } from "../../orchestrator/prompts.js";
import { loadSkillSource } from "../loader.js";
import { packagedSkills } from "./index.js";
import { iotBleFeature } from "./iot-ble-feature.js";

describe("packaged TS skill modules", () => {
  it("validates every packaged source, preserving generic as an empty workflow", () => {
    const skills = packagedSkills.map((s) => loadSkillSource(s, "packaged"));
    expect(skills[0]?.manifest).toMatchObject({ id: "generic", roles: [], stages: [] });
    const iot = loadSkillSource(iotBleFeature, "packaged");
    expect(iot.manifest.roles).toHaveLength(5);
    expect(iot.manifest.roles.filter((r) => r.required).map((r) => r.id)).toEqual([
      "device",
      "server",
    ]);
    expect(iot.manifest.stages).toMatchObject([
      { id: "contract", roles: [] },
      { id: "providers", after: ["contract"] },
      { id: "clients", after: ["providers"] },
    ]);
  });
  it("snapshots the composed IoT refine prompt", () => {
    const skill = loadSkillSource(iotBleFeature, "packaged");
    expect(
      refinePrompt({
        userText: "Add configurable auto-lock",
        peers: [],
        answers: [],
        skill: { skill, bindings: bind(skill.manifest.roles, []) },
      }),
    ).toMatchSnapshot();
  });
});
