import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLine,
  computeDelta,
  driftedFiles,
  lineStat,
  parsePorcelain,
  readDeltaRecord,
  type SnapshotIo,
  snapshotTree,
  UndoRefusedError,
  undoDelta,
  writeDeltaRecord,
} from "./session-delta.js";

const execFileP = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-delta-"));
  roots.push(dir);
  return dir;
}

const env = { PATH: process.env.PATH ?? "", HOME: tmpdir() };

function io(exclude: string[] = []): SnapshotIo {
  return {
    git: async (args, cwd) => (await execFileP("git", args, { cwd, env })).stdout,
    env,
    exclude,
  };
}

const state = (text: string | null) =>
  text === null
    ? { hash: null, content: null }
    : { hash: `h-${text}`, content: Buffer.from(text, "utf8") };

describe("delta helpers", () => {
  it("parses porcelain -z output, both sides of a rename", () => {
    expect(parsePorcelain(" M a.ts\0?? new dir/b.ts\0R  c.ts\0old c.ts\0")).toEqual([
      "a.ts",
      "new dir/b.ts",
      "c.ts",
      "old c.ts",
    ]);
  });

  it("counts added and removed lines; binary or unkept content has no count", () => {
    expect(lineStat(state("a\nb\n"), state("a\nB\nc\n"))).toEqual({ added: 2, removed: 1 });
    expect(lineStat(state(null), state("x\ny\n"))).toEqual({ added: 2, removed: 0 });
    expect(lineStat(state("x\n"), state(null))).toEqual({ added: 0, removed: 1 });
    expect(lineStat(state("a"), { hash: "h", content: Buffer.from([0, 1, 2]) })).toBeNull();
    expect(lineStat({ hash: "big", content: null }, state("x"))).toBeNull();
  });

  it("lists at most a dozen files by name and counts the rest", () => {
    const files = Array.from({ length: 14 }, (_, n) => ({
      path: `f${n}.ts`,
      before: state(null),
      after: state("x\n"),
      wasDirty: n === 0,
      added: 1,
      removed: 0,
    }));
    expect(changedLine({ files: [], partial: false })).toBe("no changes");
    expect(changedLine({ files, partial: false })).toBe(
      "changed 14 files (+14 −0): f0.ts (was already modified), f1.ts, f2.ts, f3.ts, f4.ts, " +
        "f5.ts, f6.ts, f7.ts, f8.ts, f9.ts, f10.ts, f11.ts, +2 more",
    );
  });
});

describe("snapshot and delta", () => {
  it("in a git repo, catches edits, new files, deletions and an agent's own commit", async () => {
    const root = await temp();
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env });
    const who = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
    await git("init", "--quiet", "-b", "main");
    await writeFile(path.join(root, "keep.txt"), "keep\n");
    await writeFile(path.join(root, "gone.txt"), "gone\n");
    await writeFile(path.join(root, "committed.txt"), "v1\n");
    await git("add", ".");
    await git(...who, "commit", "--quiet", "-m", "init");
    await writeFile(path.join(root, "keep.txt"), "mine\n");
    const before = await snapshotTree(root, io());
    expect([...before.files.keys()]).toEqual(["keep.txt"]);
    // The "agent": deletes, adds, commits a change, and leaves the human's edit alone.
    await rm(path.join(root, "gone.txt"));
    await writeFile(path.join(root, "new.txt"), "n\n");
    await writeFile(path.join(root, "committed.txt"), "v2\n");
    await git(...who, "commit", "--quiet", "-m", "agent", "--", "committed.txt");
    const delta = await computeDelta(before, io());
    expect(delta.files.map((f) => [f.path, f.wasDirty, f.added, f.removed])).toEqual([
      ["committed.txt", false, 1, 1],
      ["gone.txt", false, 0, 1],
      ["new.txt", false, 1, 0],
    ]);
  });

  it("outside git, walks the folder and skips the excluded home", async () => {
    const root = await temp();
    const home = path.join(root, ".skep-home");
    await mkdir(home);
    await writeFile(path.join(root, "a.txt"), "a\n");
    const before = await snapshotTree(root, io([home]));
    await writeFile(path.join(root, "a.txt"), "a\nb\n");
    await writeFile(path.join(home, "transcript.log"), "noise\n");
    const delta = await computeDelta(before, io([home]));
    expect(changedLine(delta)).toBe("changed 1 file (+1 −0): a.txt");
  });
});

describe("recorded delta and undo", () => {
  it("restores before content, refuses drift without force, and refuses a second undo", async () => {
    const root = await temp();
    const home = await temp();
    await writeFile(path.join(root, "a.txt"), "before\n");
    const before = await snapshotTree(root, io());
    await writeFile(path.join(root, "a.txt"), "after\n");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "b.txt"), "new\n");
    const delta = await computeDelta(before, io());
    const meta = { itemId: "I-2", epoch: 1, title: "t", sessionId: "s-1", root, head: null };
    await writeDeltaRecord(home, meta, delta, 1_000);
    expect((await readDeltaRecord(home, "I-2"))?.files.map((f) => f.path)).toEqual([
      "a.txt",
      "sub/b.txt",
    ]);

    await writeFile(path.join(root, "a.txt"), "edited later\n");
    await expect(undoDelta(home, "I-2", { nowMs: 2_000 })).rejects.toBeInstanceOf(UndoRefusedError);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("edited later\n");

    const outcome = await undoDelta(home, "I-2", { force: true, nowMs: 2_000 });
    expect(outcome).toMatchObject({
      restored: ["a.txt"],
      removed: ["sub/b.txt"],
      overwritten: ["a.txt"],
    });
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    await expect(undoDelta(home, "I-2", { nowMs: 3_000 })).rejects.toThrow(/already undone/);
  });

  it("refuses when an earlier content was too large to keep", async () => {
    const root = await temp();
    const home = await temp();
    await writeFile(path.join(root, "big.bin"), "now\n");
    const delta = {
      files: [
        {
          path: "big.bin",
          before: { hash: "a".repeat(64), content: null },
          after: { hash: null, content: null },
          wasDirty: false,
          added: null,
          removed: null,
        },
      ],
      partial: false,
    };
    await writeDeltaRecord(
      home,
      { itemId: "I-1", epoch: 1, title: "", sessionId: null, root, head: null },
      delta,
      0,
    );
    await expect(undoDelta(home, "I-1", { force: true, nowMs: 1 })).rejects.toThrow(
      /too large to keep/,
    );
  });

  async function gitRepo(): Promise<string> {
    const root = await temp();
    const run = (args: string[]) => io().git(args, root);
    await run(["init", "--quiet", "-b", "main"]);
    await writeFile(path.join(root, "valuable.txt"), "precious\n");
    await writeFile(path.join(root, "other.txt"), "other\n");
    await symlink("valuable.txt", path.join(root, "link.txt"));
    await run(["add", "."]);
    await run(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
    return root;
  }

  async function recordRun(root: string, home: string, change: () => Promise<void>) {
    const before = await snapshotTree(root, io());
    await change();
    const delta = await computeDelta(before, io());
    const meta = { itemId: "I-1", epoch: 1, title: "t", sessionId: "s-1", root, head: null };
    return writeDeltaRecord(home, meta, delta, 1_000);
  }

  it.each([false, true])("undo removes a new symlink, never its target (git %s)", async (git) => {
    const root = git ? await gitRepo() : await temp();
    const home = await temp();
    if (!git) await writeFile(path.join(root, "valuable.txt"), "precious\n");
    const record = await recordRun(root, home, () =>
      symlink("valuable.txt", path.join(root, "new-link.txt")),
    );
    expect(record.files).toEqual([
      expect.objectContaining({ path: "new-link.txt", before: null, afterLink: "valuable.txt" }),
    ]);
    // No drift: the link itself is compared, not the file it points to.
    const outcome = await undoDelta(home, "I-1", { nowMs: 2_000 });
    expect(outcome).toMatchObject({ removed: ["new-link.txt"], overwritten: [] });
    await expect(lstat(path.join(root, "new-link.txt"))).rejects.toThrow();
    expect(await readFile(path.join(root, "valuable.txt"), "utf8")).toBe("precious\n");
  });

  it("force removes only the recorded link even when it was retargeted later", async () => {
    const root = await gitRepo();
    const home = await temp();
    await recordRun(root, home, () => symlink("valuable.txt", path.join(root, "new-link.txt")));
    await rm(path.join(root, "new-link.txt"));
    await symlink("other.txt", path.join(root, "new-link.txt"));
    await expect(undoDelta(home, "I-1", { nowMs: 2_000 })).rejects.toThrow(/changed again/);
    await undoDelta(home, "I-1", { force: true, nowMs: 2_000 });
    await expect(lstat(path.join(root, "new-link.txt"))).rejects.toThrow();
    expect(await readFile(path.join(root, "valuable.txt"), "utf8")).toBe("precious\n");
    expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("other\n");
  });

  it("undo restores a modified committed symlink as a link to its old project file", async () => {
    const root = await gitRepo();
    const home = await temp();
    const record = await recordRun(root, home, async () => {
      await rm(path.join(root, "link.txt"));
      await symlink("other.txt", path.join(root, "link.txt"));
    });
    expect(record.files).toEqual([
      expect.objectContaining({
        path: "link.txt",
        beforeLink: "valuable.txt",
        afterLink: "other.txt",
        restorable: true,
      }),
    ]);
    const outcome = await undoDelta(home, "I-1", { nowMs: 2_000 });
    expect(outcome).toMatchObject({ restored: ["link.txt"], overwritten: [] });
    expect(await readlink(path.join(root, "link.txt"))).toBe("valuable.txt");
    expect(await readFile(path.join(root, "valuable.txt"), "utf8")).toBe("precious\n");
    expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("other\n");
  });

  it("undo of a file replaced by a symlink to another project file writes the entry, not the target", async () => {
    const root = await gitRepo();
    const home = await temp();
    await recordRun(root, home, async () => {
      await rm(path.join(root, "other.txt"));
      await symlink("valuable.txt", path.join(root, "other.txt"));
    });
    await undoDelta(home, "I-1", { nowMs: 2_000 });
    expect((await lstat(path.join(root, "other.txt"))).isFile()).toBe(true);
    expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("other\n");
    expect(await readFile(path.join(root, "valuable.txt"), "utf8")).toBe("precious\n");
  });

  it("refuses a recorded path whose parent became a symlink, changing nothing", async () => {
    const root = await temp();
    const home = await temp();
    await mkdir(path.join(root, "dir"));
    await mkdir(path.join(root, "elsewhere"));
    await writeFile(path.join(root, "elsewhere", "f.txt"), "keep\n");
    await recordRun(root, home, () => writeFile(path.join(root, "dir", "f.txt"), "new\n"));
    await rm(path.join(root, "dir"), { recursive: true });
    await symlink("elsewhere", path.join(root, "dir"));
    await expect(undoDelta(home, "I-1", { force: true, nowMs: 2_000 })).rejects.toThrow(
      /dir \(a parent of dir\/f.txt\) is no longer a plain directory/,
    );
    expect(await readFile(path.join(root, "elsewhere", "f.txt"), "utf8")).toBe("keep\n");
  });

  it.each([false, true])(
    "undo recreates every missing ancestor of a deleted nested file at its own path (git %s)",
    async (git) => {
      const root = git ? await gitRepo() : await temp();
      const home = await temp();
      const files = {
        "a/b/c/file.txt": "deep\n",
        "a/x/file.txt": "sibling\n",
        "a/file.txt": "shallow\n",
        "d/e/file.txt": "other tree\n",
      };
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), text);
      }
      if (git) {
        await io().git(["add", "."], root);
        await io().git(
          ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "tree"],
          root,
        );
      }
      const record = await recordRun(root, home, async () => {
        await rm(path.join(root, "a"), { recursive: true });
        await rm(path.join(root, "d"), { recursive: true });
      });
      expect(record.files.map((f) => f.path).sort()).toEqual(Object.keys(files).sort());

      const outcome = await undoDelta(home, "I-1", { nowMs: 2_000 });
      expect(outcome.restored.sort()).toEqual(Object.keys(files).sort());
      for (const [rel, text] of Object.entries(files)) {
        expect(await readFile(path.join(root, rel), "utf8")).toBe(text);
      }
      // Nothing landed on a collapsed path such as a/file.txt for a/b/c/file.txt or d/file.txt.
      await expect(lstat(path.join(root, "d", "file.txt"))).rejects.toThrow();
      await expect(lstat(path.join(root, "a", "c"))).rejects.toThrow();
      if (git) expect(await io().git(["status", "--porcelain"], root)).toBe("");
    },
  );

  it("still refuses a parent symlink above a missing directory, changing nothing", async () => {
    const root = await temp();
    const home = await temp();
    await mkdir(path.join(root, "dir", "sub"), { recursive: true });
    await mkdir(path.join(root, "elsewhere"));
    await writeFile(path.join(root, "dir", "sub", "f.txt"), "old\n");
    await recordRun(root, home, () => rm(path.join(root, "dir"), { recursive: true }));
    await symlink("elsewhere", path.join(root, "dir"));
    await expect(undoDelta(home, "I-1", { force: true, nowMs: 2_000 })).rejects.toThrow(
      /dir \(a parent of dir\/sub\/f.txt\) is no longer a plain directory/,
    );
    await expect(lstat(path.join(root, "elsewhere", "sub"))).rejects.toThrow();
  });

  it("a record without changes refuses undo and reports no drift", async () => {
    const root = await temp();
    const home = await temp();
    const record = await recordRun(root, home, async () => {});
    expect(record.files).toEqual([]);
    expect(await driftedFiles(record)).toEqual([]);
    await expect(undoDelta(home, "I-1", { nowMs: 1 })).rejects.toThrow(
      /latest run of I-1 \(session s-1\) changed no files/,
    );
  });

  it("driftedFiles names files changed after the item", async () => {
    const root = await temp();
    const home = await temp();
    const record = await recordRun(root, home, async () => {
      await writeFile(path.join(root, "a.txt"), "item\n");
      await writeFile(path.join(root, "b.txt"), "item\n");
    });
    expect(await driftedFiles(record)).toEqual([]);
    await writeFile(path.join(root, "b.txt"), "human\n");
    expect(await driftedFiles(record)).toEqual(["b.txt"]);
  });
});
