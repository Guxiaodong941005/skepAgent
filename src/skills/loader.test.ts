import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { SkillLoader } from "./loader.js";
import { SkillTrustStore } from "./trust.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skep-skills-"));
  dirs.push(root);
  const user = path.join(root, "user");
  const project = path.join(root, "project");
  const trust = new SkillTrustStore(root);
  return { root, user, project, trust, loader: new SkillLoader({ user, project }, trust) };
}
async function disk(root: string, id = "iot-ble-feature", changes = {}) {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  const manifest = {
    schema: "skep.skill/v1",
    id,
    name: "Custom",
    version: "1.0.0",
    description: "Custom bundle",
    master: { guidance: "master.md", synthesis: "synthesis.md" },
    ...changes,
  };
  await writeFile(path.join(dir, "skill.toml"), stringify(manifest));
  await writeFile(path.join(dir, "master.md"), "custom guidance");
  await writeFile(path.join(dir, "synthesis.md"), "custom synthesis");
  return dir;
}
describe("skill scope loader and trust", () => {
  it("shadows project > user > packaged and permits explicit scopes", async () => {
    const { loader, user, project } = await setup();
    await disk(user);
    await disk(project);
    const entries = (await loader.list()).filter((e) => e.id === "iot-ble-feature");
    expect(entries.map((e) => [e.scope, e.shadowed, e.trusted])).toEqual([
      ["project", false, false],
      ["user", true, true],
      ["packaged", true, true],
    ]);
    await expect(loader.get("iot-ble-feature")).rejects.toThrow("untrusted");
    expect((await loader.get("user:iot-ble-feature")).scope).toBe("user");
    expect((await loader.get("packaged:iot-ble-feature")).scope).toBe("packaged");
  });
  it("trusts a project digest once, stores 0600, and requires re-trust on edits", async () => {
    const { loader, trust, project } = await setup();
    const dir = await disk(project);
    const skill = await loader.get("iot-ble-feature", false);
    await trust.trust(skill);
    await expect(loader.get("iot-ble-feature")).resolves.toMatchObject({ digest: skill.digest });
    expect((await stat(trust.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(trust.file, "utf8")).toContain(skill.digest);
    await writeFile(path.join(dir, "master.md"), "edited guidance");
    await expect(loader.get("iot-ble-feature")).rejects.toThrow("untrusted");
    expect((await loader.get("iot-ble-feature", false)).digest).not.toBe(skill.digest);
  });
  it("lists invalid skills with reasons and never falls back around invalid shadowing", async () => {
    const { loader, project } = await setup();
    await disk(project, "iot-ble-feature", { surprise: true });
    const entry = (await loader.list())[0];
    expect(entry?.skill).toBeNull();
    expect(entry?.reason).toContain("Unrecognized key");
    await expect(loader.get("iot-ble-feature")).rejects.toThrow("invalid");
  });
  it("rejects .. paths and symlink escapes of files and directories", async () => {
    const { loader, project, root } = await setup();
    await disk(project, "bad-path", {
      master: { guidance: "../outside.md", synthesis: "synthesis.md" },
    });
    const dir = await disk(project, "bad-link");
    await rm(path.join(dir, "master.md"));
    await writeFile(path.join(root, "outside.md"), "outside");
    await symlink(path.join(root, "outside.md"), path.join(dir, "master.md"));
    await disk(root, "bad-dir");
    await symlink(path.join(root, "bad-dir"), path.join(project, "bad-dir"));
    const entries = await loader.list();
    expect(entries.find((e) => e.id === "bad-path")?.reason).toContain("no ..");
    expect(entries.find((e) => e.id === "bad-link")?.reason).toContain("escapes");
    expect(entries.find((e) => e.id === "bad-dir")?.reason).toContain("escapes");
    await expect(loader.get("../outside")).rejects.toThrow("skill id");
  });
  it("rejects oversized, invalid UTF-8 and secret-like text with a fixed message", async () => {
    const { loader, project } = await setup();
    const dir = await disk(project);
    await writeFile(path.join(dir, "master.md"), "x".repeat(6001));
    expect((await loader.list())[0]?.reason).toContain("6000");
    await writeFile(path.join(dir, "master.md"), Buffer.from([0xff]));
    expect((await loader.list())[0]?.reason).toContain("UTF-8");
    await writeFile(path.join(dir, "master.md"), `sk-${"a".repeat(24)}`);
    expect((await loader.list())[0]?.reason).toBe(
      "skill contains secret-like text; remove it before loading",
    );
  });
});
