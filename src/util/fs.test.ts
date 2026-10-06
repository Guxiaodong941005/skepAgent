import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendFsync, atomicWrite, PathEscapeError, safeJoin } from "./fs.js";

describe("atomicWrite", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-fs-"));
    dirs.push(dir);
    return dir;
  }

  it("replaces the target wholesale and leaves no temp files (AC 2)", async () => {
    const dir = await scratch();
    const target = path.join(dir, "state.json");
    await writeFile(target, "old");

    await atomicWrite(target, "new content");

    expect(await readFile(target, "utf8")).toBe("new content");
    const names = await readdir(dir);
    expect(names).toEqual(["state.json"]);
  });

  it("accepts bytes and applies the requested mode", async () => {
    const dir = await scratch();
    const target = path.join(dir, "blob");
    await atomicWrite(target, new Uint8Array([1, 2, 3, 4]), { mode: 0o640 });

    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it("never publishes a partial file when the write fails", async () => {
    const dir = await scratch();
    const target = path.join(dir, "state.json");
    await writeFile(target, "old");

    // A directory where the target should be makes the rename fail after the temp file is written.
    await rm(target);
    await mkdir(target);

    await expect(atomicWrite(target, "new")).rejects.toThrow();
    const names = await readdir(dir);
    expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });
});

describe("appendFsync", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates missing parent directories and appends", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-fs-"));
    dirs.push(dir);
    const file = path.join(dir, "nested", "log");

    await appendFsync(file, "one\n");
    await appendFsync(file, "two\n");

    expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
  });
});

describe("safeJoin", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-fs-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects traversal, absolute paths and NUL bytes (AC 3)", async () => {
    const root = await scratch();
    await expect(safeJoin(root, "../x")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(safeJoin(root, "/etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(safeJoin(root, "a/../../x")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(safeJoin(root, "a\0b")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a symlink inside root that points outside", async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeFile(path.join(outside, "secret"), "nope");
    await symlink(outside, path.join(root, "link"));

    await expect(safeJoin(root, "link/secret")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(safeJoin(root, "link")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("accepts nested paths that do not exist yet", async () => {
    const root = await scratch();
    const resolved = await safeJoin(root, "a/b/c.txt");
    expect(resolved).toBe(path.join(await realpath(root), "a/b/c.txt"));
  });

  it("accepts an existing file and resolves a symlink that stays inside root", async () => {
    const root = await scratch();
    await writeFile(path.join(root, "inside"), "ok");
    await symlink(path.join(root, "inside"), path.join(root, "alias"));

    const direct = await safeJoin(root, "inside");
    const aliased = await safeJoin(root, "alias");
    expect(direct).toBe(aliased);
    expect(await readFile(aliased, "utf8")).toBe("ok");
  });

  it("rejects a relative symlink whose target leaves root", async () => {
    const root = await scratch();
    await symlink("../outside", path.join(root, "escape"));
    await expect(safeJoin(root, "escape/file")).rejects.toBeInstanceOf(PathEscapeError);
  });
});
