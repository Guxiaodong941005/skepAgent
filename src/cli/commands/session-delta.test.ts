import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLine,
  computeDelta,
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
    const meta = { itemId: "I-2", epoch: 1, title: "t", root, head: null };
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
      { itemId: "I-1", epoch: 1, title: "", root, head: null },
      delta,
      0,
    );
    await expect(undoDelta(home, "I-1", { force: true, nowMs: 1 })).rejects.toThrow(
      /too large to keep/,
    );
  });
});
