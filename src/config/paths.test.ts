import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileChecked } from "../util/exec.js";
import { ProjectRootError, projectId, resolveProjectRoot, skepHome, skepPaths } from "./paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "skep-project-paths-"));
  roots.push(root);
  const cwd = path.join(root, "checkout");
  await mkdir(cwd);
  const env = { HOME: root, PATH: process.env.PATH };
  return { root, cwd, env };
}

describe("skepHome", () => {
  it("honours SKEP_HOME exactly without resolving the project or nesting", async () => {
    expect(await skepHome({ SKEP_HOME: "/tmp/skep-test" }, "/missing-checkout")).toBe(
      "/tmp/skep-test",
    );
    expect(await skepHome({ SKEP_HOME: "relative-home" }, "/missing-checkout")).toBe(
      "relative-home",
    );
  });

  it("ignores an empty SKEP_HOME and selects a stable project home", async () => {
    const { cwd, env, root } = await fixture();
    const expected = path.join(root, ".skep", "projects", projectId(await realpath(cwd)));
    expect(await skepHome({ ...env, SKEP_HOME: "" }, cwd)).toBe(expected);
    expect(await skepHome(env, cwd)).toBe(expected);
    expect(path.basename(expected)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("isolates different roots even when their basenames match", async () => {
    const { cwd, env, root } = await fixture();
    const other = path.join(root, "other", path.basename(cwd));
    await mkdir(other, { recursive: true });
    const first = await skepHome(env, cwd);
    const second = await skepHome(env, other);
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.join(root, ".skep", "projects"));
    expect(path.dirname(second)).toBe(path.dirname(first));
  });

  it("prefers the Git toplevel over a nested cwd", async () => {
    const { cwd, env } = await fixture();
    await execFileChecked("git", ["init", "--quiet", cwd]);
    const nested = path.join(cwd, "src", "nested");
    await mkdir(nested, { recursive: true });
    expect(await resolveProjectRoot(nested, env)).toBe(await realpath(cwd));
    expect(await skepHome(env, nested)).toBe(await skepHome(env, cwd));
  });

  it.each([false, true])("canonicalizes symlink aliases (Git: %j)", async (git) => {
    const { cwd, env, root } = await fixture();
    if (git) await execFileChecked("git", ["init", "--quiet", cwd]);
    const alias = path.join(root, "alias");
    await symlink(cwd, alias, "dir");
    expect(await resolveProjectRoot(alias, env)).toBe(await realpath(cwd));
    expect(await skepHome(env, alias)).toBe(await skepHome(env, cwd));
  });

  it("ignores Git environment overrides when choosing the cwd's project", async () => {
    const { cwd, env, root } = await fixture();
    const other = path.join(root, "other-repo");
    await execFileChecked("git", ["init", "--quiet", other]);
    expect(
      await resolveProjectRoot(cwd, {
        ...env,
        GIT_DIR: path.join(other, ".git"),
        GIT_WORK_TREE: other,
      }),
    ).toBe(await realpath(cwd));
  });

  it("uses cwd outside a Git work tree, including a bare repository", async () => {
    const { cwd, env } = await fixture();
    await execFileChecked("git", ["init", "--bare", "--quiet", cwd]);
    expect(await resolveProjectRoot(cwd, env)).toBe(await realpath(cwd));
  });

  it("reports an actionable typed error if the cwd cannot be resolved", async () => {
    const { env, root } = await fixture();
    await expect(skepHome(env, path.join(root, "missing"))).rejects.toBeInstanceOf(
      ProjectRootError,
    );
    await expect(skepHome(env, path.join(root, "missing"))).rejects.toThrow(/SKEP_HOME \/ --home/);
  });

  it("does not read SKEP_HOME from the real process environment", async () => {
    // Passing an explicit env keeps the test from depending on (or writing via) the user's home.
    expect(await skepHome({ SKEP_HOME: "/var/skep" })).toBe("/var/skep");
  });
});

describe("skepPaths", () => {
  it("returns absolute paths for every well-known file", () => {
    const paths = skepPaths("/tmp/skep-home");
    for (const p of Object.values(paths)) {
      expect(path.isAbsolute(p)).toBe(true);
    }
    expect(paths).toEqual({
      home: "/tmp/skep-home",
      deviceToml: "/tmp/skep-home/device.toml",
      allowedSigners: "/tmp/skep-home/allowed_signers",
      socket: "/tmp/skep-home/skepd.sock",
      lockFile: "/tmp/skep-home/skepd.lock",
      blackboardClone: "/tmp/skep-home/blackboard",
      cliBlackboardClone: "/tmp/skep-home/cli-blackboard",
      keysDir: "/tmp/skep-home/keys",
    });
  });

  it("resolves a relative home against the cwd", () => {
    const paths = skepPaths("rel-home");
    expect(paths.home).toBe(path.resolve("rel-home"));
    expect(paths.socket).toBe(path.resolve("rel-home", "skepd.sock"));
  });
});
