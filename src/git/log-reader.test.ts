import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitFile,
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../../test/helpers/git-fixture.js";
import {
  agentRegistered,
  fakeEventId,
  fakeSha,
  genesisDoc,
  LogBuilder,
  MAC,
  VPS,
} from "../../test/helpers/log-builder.js";
import { eventPath } from "../core/ids.js";
import { replay } from "../core/reducer/replay.js";
import { MAX_EVENT_BYTES } from "../core/schemas/common.js";
import { serializeEvent } from "../core/schemas/events.js";
import { writeSignedCommit, writeTreeFromIndex } from "./commit.js";
import { LogReadError, type ReadLogOptions, readLog } from "./log-reader.js";
import { type GitResult, type GitRunner, NodeGitRunner } from "./runner.js";
import { type Signer, SshKeySigner } from "./signer.js";

describe("real Git log reader", () => {
  const git = new NodeGitRunner();
  let root: string;
  let repo: string;
  let trustPath: string;
  let human: SshKeySigner;
  let mac: SshKeySigner;
  let vps: SshKeySigner;

  beforeAll(async () => {
    root = await tempDir("log-reader-");
    vi.stubEnv("HOME", root);
    const humanKey = await generateKey(root, "human");
    const macKey = await generateKey(root, "mac");
    const vpsKey = await generateKey(root, "vps");
    human = new SshKeySigner({ principal: "human", keyPath: humanKey.privPath });
    mac = new SshKeySigner({ principal: "daemon:mac", keyPath: macKey.privPath });
    vps = new SshKeySigner({ principal: "daemon:vps", keyPath: vpsKey.privPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [
      { principal: human.principal, pubLine: humanKey.pubLine },
      { principal: mac.principal, pubLine: macKey.pubLine },
      { principal: vps.principal, pubLine: vpsKey.pubLine },
    ]);
  });

  beforeEach(async () => {
    repo = await mkdtemp(join(root, "repo-"));
    await initRepo(repo);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function genesis(): Promise<string> {
    return commitFile(git, repo, "skep.json", `${JSON.stringify(genesisDoc(), null, 2)}\n`, human);
  }

  function registration(n: number, parent: string, actor = MAC): { path: string; content: string } {
    const event = new LogBuilder().event(
      {
        type: "agent.registered",
        actor,
        event_id: fakeEventId(n),
        payload: agentRegistered(),
      },
      parent,
    );
    return { path: eventPath(null, event.event_id), content: serializeEvent(event) };
  }

  async function commitFiles(
    files: { path: string; content: string | Uint8Array }[],
    opts: { parents?: string[]; signer?: Signer } = {},
  ): Promise<string> {
    for (const file of files) {
      const path = join(repo, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    await git.run(["add", "--", ...files.map((file) => file.path)], { cwd: repo });
    const head = (await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const ident = {
      name: "Skep Test",
      email: "test@example.invalid",
      timestampSec: 1_791_244_800,
      tz: "+0000",
    };
    const sha = await writeSignedCommit(git, repo, {
      tree: await writeTreeFromIndex(git, repo),
      parents: opts.parents ?? [head],
      author: ident,
      committer: ident,
      message: "Test event files\n",
      signer: opts.signer ?? mac,
    });
    await git.run(["update-ref", "HEAD", sha, head], { cwd: repo });
    return sha;
  }

  it("reads genesis and three signed events with exact contents and principals (AC 1)", async () => {
    const shas = [await genesis()];
    const documents: { path: string; content: string }[] = [];
    for (const [i, signer] of [mac, vps, mac].entries()) {
      const doc = registration(i, shas.at(-1) ?? "", signer === mac ? MAC : VPS);
      documents.push(doc);
      shas.push(await commitFile(git, repo, doc.path, doc.content, signer));
    }
    const entries = await readLog(git, repo, trustPath);
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(entries.map((entry) => entry.sha)).toEqual(shas);
    expect(entries[0]).toEqual({
      seq: 0,
      sha: shas[0],
      parents: [],
      signature: { status: "good", principal: "human" },
      changes: [{ status: "A", path: "skep.json" }],
      added: { "skep.json": `${JSON.stringify(genesisDoc(), null, 2)}\n` },
    });
    for (const [i, doc] of documents.entries()) {
      expect(entries[i + 1]).toEqual({
        seq: i + 1,
        sha: shas[i + 1],
        parents: [shas[i]],
        signature: { status: "good", principal: i === 1 ? "daemon:vps" : "daemon:mac" },
        changes: [{ status: "A", path: doc.path }],
        added: { [doc.path]: doc.content },
      });
    }
    expect(replay(entries).outcomes.map(({ outcome }) => outcome)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
  });

  it("preserves invalid commits and first-parent merge diffs for reducer auditing (AC 2)", async () => {
    const first = await genesis();
    await git.run(["checkout", "-b", "side"], { cwd: repo });
    const sideDoc = registration(10, first);
    const side = await commitFile(git, repo, sideDoc.path, sideDoc.content, mac);
    await git.run(["checkout", "main"], { cwd: repo });
    const merge = await commitFiles([sideDoc], { parents: [first, side] });
    await commitFiles([registration(11, merge), registration(12, merge)]);
    await commitFile(git, repo, sideDoc.path, "Changed file\n", mac);
    await commitFile(git, repo, registration(13, merge).path, "Unsigned file\n");
    const oversizedPath = registration(14, merge).path;
    await commitFile(git, repo, oversizedPath, "x".repeat(MAX_EVENT_BYTES + 1), mac);
    const binaryPath = registration(15, merge).path;
    await commitFiles([{ path: binaryPath, content: Buffer.from([0x66, 0xf0, 0x90, 0x80]) }]);
    await commitFile(git, repo, "notes.txt", "Do not read this file\n", mac);
    const finalParent = (await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const finalDoc = registration(16, finalParent);
    await commitFile(git, repo, finalDoc.path, finalDoc.content, mac);
    const entries = await readLog(git, repo, trustPath);
    expect(entries).toHaveLength(9);
    expect(entries.map(({ sha }) => sha)).not.toContain(side);
    expect(entries[1]).toMatchObject({
      parents: [first, side],
      changes: [{ status: "A", path: sideDoc.path }],
      added: { [sideDoc.path]: sideDoc.content },
    });
    expect(entries[2]?.changes).toHaveLength(2);
    expect(Object.keys(entries[2]?.added ?? {})).toHaveLength(2);
    expect(entries[3]).toMatchObject({ changes: [{ status: "M", path: sideDoc.path }], added: {} });
    expect(entries[4]?.signature).toEqual({ status: "missing" });
    expect(entries[5]?.added).toEqual({ [oversizedPath]: null });
    expect(entries[6]?.added).toEqual({ [binaryPath]: null });
    expect(entries[7]).toMatchObject({ changes: [{ status: "A", path: "notes.txt" }], added: {} });
    expect(entries[8]?.added).toEqual({ [finalDoc.path]: finalDoc.content });
    const state = replay(entries);
    expect(state.outcomes.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["invalid", "not_linear"],
      ["invalid", "not_single_add"],
      ["invalid", "not_single_add"],
      ["invalid", "unsigned"],
      ["invalid", "unreadable_event"],
      ["invalid", "unreadable_event"],
      ["invalid", "bad_event_path"],
      ["accepted", null],
    ]);
    expect(state.agents[MAC]?.registered_seq).toBe(8);
    await expect(readLog(git, repo, trustPath, { from: { sha: side, seq: 1 } })).rejects.toThrow(
      /first-parent chain/,
    );
  });

  it("matches every incremental suffix, honors another ref, and returns no work at the tip (AC 3)", async () => {
    let parent = await genesis();
    for (let i = 20; i < 23; i++) {
      const doc = registration(i, parent);
      parent = await commitFile(git, repo, doc.path, doc.content, mac);
    }
    const entries = await readLog(git, repo, trustPath);
    for (const entry of entries) {
      expect(
        await readLog(git, repo, trustPath, { from: { sha: entry.sha, seq: entry.seq } }),
      ).toEqual(entries.slice(entry.seq + 1));
    }
    await git.run(["branch", "saved", parent], { cwd: repo });
    const doc = registration(23, parent);
    await commitFile(git, repo, doc.path, doc.content, mac);
    expect(await readLog(git, repo, trustPath, { ref: "refs/heads/saved" })).toEqual(entries);
    await expect(
      readLog(git, repo, trustPath, { from: { sha: entries[1]?.sha ?? "", seq: 0 } }),
    ).rejects.toThrow(/cached seq/);
  });

  it("alarms when the cached tip was removed by a history rewrite (AC 3)", async () => {
    const first = await genesis();
    const doc = registration(30, first);
    const previous = await commitFile(git, repo, doc.path, doc.content, mac);
    await commitFiles(
      [
        {
          path: "skep.json",
          content: JSON.stringify({ ...genesisDoc(), blackboard_id: "bb_rewritten" }),
        },
      ],
      { parents: [], signer: human },
    );
    await expect(
      readLog(git, repo, trustPath, { from: { sha: previous, seq: 1 } }),
    ).rejects.toBeInstanceOf(LogReadError);
    await expect(
      readLog(git, repo, trustPath, { from: { sha: fakeSha("missing"), seq: 1 } }),
    ).rejects.toThrow(/history rewrite/);
    expect(await readLog(git, repo, trustPath)).toHaveLength(1);
  });

  it("uses one metadata log, one verification log and one cat-file for 50 commits (AC 5)", async () => {
    let parent = await genesis();
    for (let i = 40; i < 89; i++) {
      const doc = registration(i, parent);
      parent = await commitFile(git, repo, doc.path, doc.content, mac);
    }
    const run = vi.fn(git.run.bind(git));
    const entries = await readLog({ run }, repo, trustPath);
    expect(entries).toHaveLength(50);
    expect(run).toHaveBeenCalledTimes(54);
    for (const [command, count] of [
      ["rev-list", 1],
      ["log", 2],
      ["diff-tree", 50],
      ["cat-file", 1],
    ] as const) {
      expect(run.mock.calls.filter(([args]) => args.includes(command))).toHaveLength(count);
    }
    expect(entries.every(({ signature }) => signature.status === "good")).toBe(true);
    const batch = run.mock.calls.find(([args]) => args.includes("cat-file"));
    expect(typeof batch?.[1].input).toBe("string");
    if (typeof batch?.[1].input !== "string") throw new Error("Missing cat-file batch input");
    expect(batch[1].input.split("\0")).toHaveLength(51);
  });

  it("ignores repository-local display, rename, signature and trust settings (AC 6)", async () => {
    await genesis();
    const unusualPath = "events/_skep/file with space\tand\nnewline.json";
    const content = "Exact Unicode: \ufffd \u00e9 \ud83d\ude80\n";
    await commitFile(git, repo, unusualPath, content, mac);
    await git.run(["mv", "--", unusualPath, "events/_skep/renamed.json"], { cwd: repo });
    const ident = {
      name: "Skep Test",
      email: "test@example.invalid",
      timestampSec: 1_791_244_800,
      tz: "+0000",
    };
    const parent = (await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const renamed = await writeSignedCommit(git, repo, {
      tree: await writeTreeFromIndex(git, repo),
      parents: [parent],
      author: ident,
      committer: ident,
      message: "Rename event file\n",
      signer: mac,
    });
    await git.run(["update-ref", "HEAD", renamed, parent], { cwd: repo });
    const expected = await readLog(git, repo, trustPath);
    for (const [key, value] of [
      ["core.quotePath", "false"],
      ["diff.renames", "true"],
      ["log.showSignature", "true"],
      ["color.ui", "always"],
      ["log.decorate", "full"],
      ["gpg.format", "openpgp"],
      ["gpg.ssh.allowedSignersFile", join(repo, "untrusted")],
      ["gpg.ssh.program", "invalid-verifier"],
    ]) {
      await git.run(["config", key ?? "", value ?? ""], { cwd: repo });
    }
    expect(await readLog(git, repo, trustPath)).toEqual(expected);
    expect(expected[1]?.changes).toEqual([{ status: "A", path: unusualPath }]);
    expect(expected[1]?.added).toEqual({ [unusualPath]: content });
    expect(expected[2]?.changes).toEqual([
      { status: "D", path: unusualPath },
      { status: "A", path: "events/_skep/renamed.json" },
    ]);
  });

  it("preserves empty, BOM and exactly-limit UTF-8 files without reading other paths", async () => {
    await genesis();
    const files = [
      { path: "events/_skep/empty.json", content: "" },
      { path: "events/_skep/bom.json", content: "\ufeffExact content\n" },
      { path: "events/_skep/limit.json", content: "\u00e9".repeat(MAX_EVENT_BYTES / 2) },
      { path: "events/_skep/oversized.json", content: "\u00e9".repeat(MAX_EVENT_BYTES / 2 + 1) },
      { path: "policy/allowed_signers.txt", content: "Untrusted repository policy\n" },
    ];
    await commitFiles(files);
    await commitFile(git, repo, "skep.json", "Later genesis modification\n", human);
    const entries = await readLog(git, repo, trustPath);
    expect(entries[1]?.added).toEqual({
      [files[0]?.path ?? ""]: "",
      [files[1]?.path ?? ""]: files[1]?.content,
      [files[2]?.path ?? ""]: files[2]?.content,
      [files[3]?.path ?? ""]: null,
    });
    expect(entries[2]?.added).toEqual({});
  });

  it("maps deletion and type changes without reading their contents", async () => {
    await genesis();
    await commitFile(git, repo, "events/_skep/type.json", "Original file\n", mac);
    await rm(join(repo, "events/_skep/type.json"));
    await symlink("skep.json", join(repo, "events/_skep/type.json"));
    await commitFiles([{ path: "note.txt", content: "Extra file\n" }]);
    await git.run(["add", "--", "events/_skep/type.json"], { cwd: repo });
    await commitFiles([{ path: "note.txt", content: "Changed note\n" }]);
    await git.run(["rm", "--", "events/_skep/type.json"], { cwd: repo });
    await commitFiles([{ path: "note.txt", content: "Final note\n" }]);
    const entries = await readLog(git, repo, trustPath);
    expect(entries[3]?.changes).toContainEqual({ status: "T", path: "events/_skep/type.json" });
    expect(entries[3]?.added).toEqual({});
    expect(entries[4]?.changes).toContainEqual({ status: "D", path: "events/_skep/type.json" });
    expect(entries[4]?.added).toEqual({});
  });

  it("wraps missing refs as actionable read errors", async () => {
    await expect(readLog(git, repo, trustPath)).rejects.toBeInstanceOf(LogReadError);
  });
});

describe("log reader boundaries", () => {
  const shas = [fakeSha("reader-root"), fakeSha("reader-child")];
  const doc = JSON.stringify(genesisDoc());
  const git = (override?: (args: string[], result: GitResult) => GitResult): GitRunner => ({
    run: vi.fn(async (args: string[]) => {
      let stdout: string;
      if (args.includes("rev-list")) stdout = `${shas.join("\n")}\n`;
      else if (args.includes("merge-base")) stdout = "";
      else if (args.includes("log")) {
        const requested = args.filter((arg) => shas.includes(arg));
        stdout = requested
          .map((sha) =>
            args.includes("--format=%H%x00%P")
              ? `${sha}\0${sha === shas[0] ? "" : shas[0]}\n`
              : `${sha}\0G\0human\0fingerprint\n`,
          )
          .join("");
      } else if (args.includes("diff-tree")) {
        stdout = args.includes("--root") ? "A\0skep.json\0" : "A\0events/_skep/test.json\0";
      } else if (args.includes("cat-file")) {
        const marker = args
          .find((arg) => arg.startsWith("--batch="))
          ?.slice(8)
          .split("%(objectname)")[0];
        const header = (body: string) => {
          const size = Buffer.byteLength(body);
          const oid = createHash("sha1").update(`blob ${size}\0${body}`).digest("hex");
          return `${marker}${oid} blob ${size}\n${body}\n`;
        };
        stdout = `${header(doc)}${header("{}")}`;
      } else throw new Error(`Unexpected git command ${args.join(" ")}`);
      const result = { code: 0, stdout, stderr: "" };
      return override?.(args, result) ?? result;
    }),
  });

  it.each([
    { ref: "--all" },
    { ref: "main\n" },
    { from: { sha: `${shas[0]}\n`, seq: 0 } },
    { from: { sha: shas[0], seq: -1 } },
    { from: { sha: shas[0], seq: 0.5 } },
    { from: { sha: shas[0], seq: Number.MAX_SAFE_INTEGER + 1 } },
  ])("validates options before executing git: %j", async (options) => {
    const runner = git();
    await expect(
      readLog(runner, "/repo", "/local/signers", options as ReadLogOptions),
    ).rejects.toBeInstanceOf(LogReadError);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    ["rev-list", "malformed\n"],
    ["rev-list", `${shas[0]}\n${shas[0]}\n`],
    ["log", "malformed\n"],
    ["log", ""],
    ["log", `${shas[0]}\0\n${shas[0]}\0\n`],
    ["log", `${fakeSha("unexpected")}\0\n`],
    ["diff-tree", "A\0truncated"],
    ["diff-tree", "A\0"],
    ["cat-file", "missing object\n"],
  ])("rejects malformed %s output", async (command, output) => {
    await expect(
      readLog(
        git((args, result) => (args.includes(command) ? { ...result, stdout: output } : result)),
        "/repo",
        "/local/signers",
      ),
    ).rejects.toBeInstanceOf(LogReadError);
  });

  it("keeps metadata ordered by rev-list, rather than git log output order", async () => {
    const entries = await readLog(
      git((args, result) =>
        args.includes("log")
          ? { ...result, stdout: `${result.stdout.trimEnd().split("\n").reverse().join("\n")}\n` }
          : result,
      ),
      "/repo",
      "/local/signers",
    );
    expect(entries.map(({ sha }) => sha)).toEqual(shas);
    expect(entries[0]?.added).toEqual({ "skep.json": doc });
  });

  it("maps unrecognized and rename/copy statuses to other", async () => {
    const entries = await readLog(
      git((args, result) =>
        args.includes("diff-tree") && !args.includes("--root")
          ? {
              ...result,
              stdout: "X\0unknown.txt\0R100\0old.txt\0new.txt\0C100\0source.txt\0copy.txt\0",
            }
          : args.includes("cat-file")
            ? {
                ...result,
                stdout: result.stdout.slice(
                  0,
                  result.stdout.indexOf("\nskep-", result.stdout.indexOf("\n") + 1) + 1,
                ),
              }
            : result,
      ),
      "/repo",
      "/local/signers",
    );
    expect(entries[1]?.changes).toEqual([
      { status: "other", path: "unknown.txt" },
      { status: "other", path: "new.txt" },
      { status: "other", path: "copy.txt" },
    ]);
  });

  it("rejects truncated batch content and invalid size headers", async () => {
    for (const transform of [
      (stdout: string) => stdout.slice(0, -1),
      (stdout: string) => stdout.replace(/blob \d+/, "blob -1"),
    ]) {
      await expect(
        readLog(
          git((args, result) =>
            args.includes("cat-file") ? { ...result, stdout: transform(result.stdout) } : result,
          ),
          "/repo",
          "/local/signers",
        ),
      ).rejects.toBeInstanceOf(LogReadError);
    }
  });

  it("bounds metadata and verification argv to 64 KiB for long histories", async () => {
    const chain = Array.from({ length: 1800 }, (_, i) => fakeSha(`long-${i}`));
    const run = vi.fn(async (args: string[]) => {
      let stdout = "";
      if (args.includes("rev-list")) stdout = `${chain.join("\n")}\n`;
      else if (args.includes("log")) {
        expect(args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0)).toBeLessThan(
          64 * 1024,
        );
        stdout = args
          .filter((arg) => chain.includes(arg))
          .map((sha) =>
            args.includes("--format=%H%x00%P")
              ? `${sha}\0${chain[chain.indexOf(sha) - 1] ?? ""}\n`
              : `${sha}\0N\0\0\n`,
          )
          .join("");
      }
      return { code: 0, stdout, stderr: "" };
    });
    const entries = await readLog({ run }, "/repo", "/local/signers");
    expect(entries).toHaveLength(chain.length);
    expect(run.mock.calls.filter(([args]) => args.includes("log"))).toHaveLength(4);
    expect(run.mock.calls.filter(([args]) => args.includes("cat-file"))).toHaveLength(0);
  });

  it("preserves the cause of Git I/O failures", async () => {
    const cause = new Error("Git I/O failed");
    const runner: GitRunner = {
      run: vi.fn(async () => {
        throw cause;
      }),
    };
    const result = readLog(runner, "/repo", "/local/signers");
    await expect(result).rejects.toMatchObject({ name: "LogReadError", cause });
  });
});
