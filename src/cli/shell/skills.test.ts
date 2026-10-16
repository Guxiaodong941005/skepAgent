import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillPeer } from "../../core/skills/compose.js";
import { SkillLoader } from "../../skills/loader.js";
import { loadSkillDefault } from "../../skills/settings.js";
import { SkillTrustStore } from "../../skills/trust.js";
import { ShellSkills } from "./skills.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skep-shell-skills-"));
  dirs.push(root);
  const project = path.join(root, "project");
  const user = path.join(root, "user");
  const trust = new SkillTrustStore(root);
  const loader = new SkillLoader({ project, user }, trust);
  const peers: SkillPeer[] = [
    { peerId: "p1", device: "device", repo: "test-sdk", role: "device", protocolVersion: 1 },
    { peerId: "p2", device: "server", repo: "test-api", role: "server", protocolVersion: 2 },
  ];
  const file = path.join(root, "device.toml");
  const shell = new ShellSkills(loader, trust, file, () => peers);
  await shell.initialize();
  return { root, project, user, loader, trust, peers, file, shell };
}
describe("shell skill commands (§4.1)", () => {
  it("lists available skills in any shell and defaults to generic", async () => {
    const { shell } = await setup();
    expect(shell.selection).toBe("generic");
    expect(await shell.context()).toBeUndefined();
    expect(await shell.list()).toContain("generic 1.0.0 (packaged) roles: — active");
    expect(await shell.command("show iot-ble-feature", "auto", false)).toContain("master.md:");
    await expect(shell.command("use iot-ble-feature", "auto", false)).rejects.toThrow(
      "master shell",
    );
    await expect(shell.command("", "auto", false)).rejects.toThrow("master shell");
  });
  it("use shows bindings, v1 warning and advisory hint without changing the mode", async () => {
    const { shell } = await setup();
    const shown = await shell.command("use iot-ble-feature", "auto", true);
    expect(shown).toContain("skill iot-ble-feature");
    expect(shown).toContain("test-sdk");
    expect(shown).toContain("brief cut at 4000");
    expect(shown).toContain("suggests /orchestrate confirm");
    expect(await shell.command("", "confirm", true)).not.toContain("suggests");
    expect(await shell.command("use iot-ble-feature", "off", true)).toContain(
      "inactive while /orchestrate is off",
    );
    expect(await shell.command("off", "auto", true)).toContain("skill generic");
    expect(await shell.context()).toBeUndefined();
  });
  it("bind/unbind override automatic matching, refresh on roster changes, and reject unknown roles/peers", async () => {
    const { shell, peers } = await setup();
    await shell.command("use iot-ble-feature", "auto", true);
    expect(await shell.command("bind device p2", "auto", true)).toContain(
      "device | C++ device / SDK layer | p2",
    );
    expect(await shell.command("unbind device", "auto", true)).toContain(
      "required — dispatch blocked",
    );
    await expect(shell.command("bind missing p1", "auto", true)).rejects.toThrow("unknown");
    await expect(shell.command("bind device absent", "auto", true)).rejects.toThrow("no connected");
    peers.splice(1, 1);
    expect((await shell.context())?.bindings.find((b) => b.role === "server")?.repo).toBeNull();
  });
  it("persists only with --default, reads it on a new shell and clears it with off --default", async () => {
    const { shell, loader, trust, peers, file } = await setup();
    await writeFile(file, '[agent]\ncli = "codex"\n\n[orchestrate]\nmode = "auto"\n');
    await shell.command("use iot-ble-feature", "auto", true);
    expect(await loadSkillDefault(file)).toBeNull();
    await shell.command("use iot-ble-feature --default", "auto", true);
    const next = new ShellSkills(loader, trust, file, () => peers);
    await next.initialize();
    expect((await next.context())?.skill.manifest.id).toBe("iot-ble-feature");
    expect(await readFile(file, "utf8")).toContain('[agent]\ncli = "codex"');
    await next.command("off --default", "auto", true);
    expect(await loadSkillDefault(file)).toBeNull();
    expect(await readFile(file, "utf8")).toContain('mode = "auto"');
  });
  it("shows project content before trust and invalidates trust after edits", async () => {
    const { shell, project } = await setup();
    const dir = path.join(project, "custom-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "skill.toml"),
      stringify({
        schema: "skep.skill/v1",
        id: "custom-skill",
        name: "Custom",
        version: "1.0.0",
        description: "Test",
        master: { guidance: "master.md", synthesis: "synthesis.md" },
      }),
    );
    await writeFile(path.join(dir, "master.md"), "Reviewed guidance");
    await writeFile(path.join(dir, "synthesis.md"), "Checklist");
    expect(await shell.list()).toContain("untrusted");
    expect(await shell.command("show custom-skill", "auto", false)).toContain("Reviewed guidance");
    await expect(shell.command("use custom-skill", "auto", true)).rejects.toThrow("untrusted");
    expect(await shell.command("trust custom-skill", "auto", true)).toContain(
      "trusted custom-skill",
    );
    await shell.command("use custom-skill", "auto", true);
    await writeFile(path.join(dir, "master.md"), "Edited");
    await expect(shell.context()).rejects.toThrow("untrusted");
  });
  it("emits a first-start tip only with non-generic availability and no persisted default", async () => {
    const { shell, loader, trust, file } = await setup();
    expect(await shell.tip()).toContain("e.g.");
    expect(await shell.tip()).toBe("");
    await shell.command("use generic --default", "auto", true);
    const next = new ShellSkills(loader, trust, file, () => []);
    await next.initialize();
    expect(await next.tip()).toBe("");
    const empty = new ShellSkills(new SkillLoader({}, undefined, []), null, undefined, () => []);
    await empty.initialize();
    expect(await empty.tip()).toBe("");
  });
});

describe("persisted project trust recovery", () => {
  it("keeps listing, show, trust and off available for an untrusted default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skep-skill-recovery-"));
    dirs.push(root);
    const project = path.join(root, "project");
    const dir = path.join(project, "custom-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "skill.toml"),
      stringify({
        schema: "skep.skill/v1",
        id: "custom-skill",
        name: "Custom",
        version: "1.0.0",
        description: "Test",
        master: { guidance: "master.md", synthesis: "synthesis.md" },
      }),
    );
    await writeFile(path.join(dir, "master.md"), "Review this");
    await writeFile(path.join(dir, "synthesis.md"), "Check");
    const file = path.join(root, "device.toml");
    await writeFile(file, '[skill]\ndefault = "custom-skill"\n');
    const trust = new SkillTrustStore(root);
    const shell = new ShellSkills(new SkillLoader({ project }, trust), trust, file, () => []);
    await shell.initialize();
    await expect(shell.context()).rejects.toThrow("untrusted");
    expect(await shell.list()).toContain("untrusted");
    expect(await shell.command("show custom-skill", "auto", false)).toContain("Review this");
    await shell.command("trust custom-skill", "auto", true);
    expect((await shell.context())?.skill.manifest.id).toBe("custom-skill");
    await shell.command("off --default", "auto", true);
    expect(await loadSkillDefault(file)).toBeNull();
  });
});
