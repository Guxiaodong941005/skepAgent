import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitFile,
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../../test/helpers/git-fixture.js";
import {
  buildCommitText,
  type Ident,
  insertSignature,
  writeSignedCommit,
  writeTreeFromIndex,
} from "./commit.js";
import { NodeGitRunner } from "./runner.js";
import { SshKeySigner } from "./signer.js";
import { verifyCommits } from "./verify.js";

const ident: Ident = {
  name: "Skep Daemon",
  email: "skepd@mac",
  timestampSec: 1_791_244_800,
  tz: "+0230",
};
const fields = {
  tree: "a".repeat(40),
  parents: ["b".repeat(40), "c".repeat(40)],
  author: ident,
  committer: { ...ident, name: "Human", email: "human@example.invalid", tz: "-0700" },
  message: "plan.proposed\n\nDetails.\n",
};

describe("commit text", () => {
  it("preserves ordered parents, separate identities, timestamps, timezone and multiline message", () => {
    expect(buildCommitText(fields)).toBe(
      `tree ${fields.tree}\nparent ${fields.parents[0]}\nparent ${fields.parents[1]}\nauthor Skep Daemon <skepd@mac> 1791244800 +0230\ncommitter Human <human@example.invalid> 1791244800 -0700\n\nplan.proposed\n\nDetails.\n`,
    );
  });

  it("supports root commits, SHA-256 object IDs and appends a missing final LF", () => {
    const text = buildCommitText({ ...fields, tree: "d".repeat(64), parents: [], message: "root" });
    expect(text).toMatch(/^tree d{64}\nauthor /);
    expect(text).not.toContain("parent ");
    expect(text).toMatch(/\n\nroot\n$/);
  });

  it.each([
    { tree: "--bad-option" },
    { tree: `${"a".repeat(40)}\n` },
    { parents: ["not-a-sha"] },
    { parents: [`${"b".repeat(40)}\n`] },
    { author: { ...ident, name: "bad\ngpgsig forged" } },
    { author: { ...ident, name: "bad\n" } },
    { committer: { ...ident, email: "evil> <other" } },
    { committer: { ...ident, email: "human@example.invalid\n" } },
    { author: { ...ident, timestampSec: 0.5 } },
    { author: { ...ident, tz: "+2499" } },
    { author: { ...ident, tz: "+0000\n" } },
    { message: "NUL\0message" },
  ])("rejects invalid fields and header injection: %j", (override) => {
    expect(() => buildCommitText({ ...fields, ...override })).toThrow();
  });

  it("folds every signature continuation and preserves message text", () => {
    const signature = "-----BEGIN SSH SIGNATURE-----\nYWJj\nZGVm\n-----END SSH SIGNATURE-----\n";
    const text = buildCommitText(fields);
    const signed = insertSignature(text, signature);
    expect(signed).toContain(
      "\ngpgsig -----BEGIN SSH SIGNATURE-----\n YWJj\n ZGVm\n -----END SSH SIGNATURE-----\n\nplan.proposed",
    );
    expect(insertSignature(text, signature.slice(0, -1))).toBe(signed);
    expect(() => insertSignature(signed, signature)).toThrow(TypeError);
    expect(() => insertSignature("no separator", signature)).toThrow(TypeError);
    expect(() => insertSignature(text, "not a signature")).toThrow();
  });
});

describe("git commit plumbing", () => {
  const git = new NodeGitRunner();
  let root: string;
  let repo: string;
  let signer: SshKeySigner;
  let trustPath: string;
  let keyPath: string;

  beforeAll(async () => {
    root = await tempDir("commit-");
    vi.stubEnv("HOME", root);
    const key = await generateKey(root, "daemon");
    keyPath = key.privPath;
    signer = new SshKeySigner({ principal: "daemon:mac", keyPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [{ principal: "daemon:mac", pubLine: key.pubLine }]);
  });

  beforeEach(async () => {
    repo = await mkdtemp(join(root, "repo-"));
    await initRepo(repo);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("creates a verifiable commit with the exact tree, parent and message (AC 1)", async () => {
    const parent = await commitFile(git, repo, "initial.txt", "initial\n");
    await writeFile(join(repo, "event.json"), '{"event":"signed"}\n');
    await git.run(["add", "event.json"], { cwd: repo });
    const tree = await writeTreeFromIndex(git, repo);
    const commitFields = {
      tree,
      parents: [parent],
      author: ident,
      committer: ident,
      message: "plan.proposed _skep evt_test\n\nBody with café.\n",
    };
    const sha = await writeSignedCommit(git, repo, { ...commitFields, signer });
    const { stdout: object } = await git.run(["cat-file", "-p", sha], { cwd: repo });
    expect(object.replace(/^gpgsig .*\n(?: .*\n)*/m, "")).toBe(buildCommitText(commitFields));
    expect(object).toContain("gpgsig -----BEGIN SSH SIGNATURE-----\n ");
    expect(await verifyCommits(git, repo, trustPath, [sha])).toEqual({
      [sha]: { status: "good", principal: "daemon:mac" },
    });
    const checked = await git.run(
      [
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.allowedSignersFile=${trustPath}`,
        "verify-commit",
        sha,
      ],
      { cwd: repo },
    );
    expect(checked.code).toBe(0);
    expect(checked.stderr).toContain('Good "git" signature for daemon:mac');
    expect(await writeSignedCommit(git, repo, { ...commitFields, signer })).toBe(sha);
    expect((await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()).toBe(parent);
  });

  it("writes only staged files into the tree", async () => {
    await writeFile(join(repo, "staged.txt"), "staged\n");
    await writeFile(join(repo, "unstaged.txt"), "unstaged\n");
    await git.run(["add", "staged.txt"], { cwd: repo });
    const tree = await writeTreeFromIndex(git, repo);
    expect((await git.run(["ls-tree", "--name-only", tree], { cwd: repo })).stdout).toBe(
      "staged.txt\n",
    );
  });

  it("round-trips the exact signature header produced by stock git commit -S (AC 4)", async () => {
    await writeFile(join(repo, "stock.txt"), "stock\n");
    await git.run(["add", "stock.txt"], { cwd: repo });
    await git.run(
      [
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${keyPath}`,
        "commit",
        "-S",
        "--cleanup=verbatim",
        "-F",
        "-",
      ],
      {
        cwd: repo,
        input: "Stock signing\n\nVerbatim message.\n",
        env: {
          GIT_AUTHOR_DATE: `${ident.timestampSec} ${ident.tz}`,
          GIT_COMMITTER_DATE: `${ident.timestampSec} ${ident.tz}`,
        },
      },
    );
    const sha = (await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const object = (await git.run(["cat-file", "-p", sha], { cwd: repo })).stdout;
    const unsigned = object.replace(/^gpgsig .*\n(?: .*\n)*/m, "");
    expect(insertSignature(unsigned, await signer.sign(Buffer.from(unsigned)))).toBe(object);
    expect(await verifyCommits(git, repo, trustPath, [sha])).toEqual({
      [sha]: { status: "good", principal: "daemon:mac" },
    });
  });

  it("supports signed orphan commits in bare repositories", async () => {
    const bare = join(repo, "bare.git");
    await initRepo(bare, { bare: true });
    const tree = (await git.run(["mktree"], { cwd: bare, input: "" })).stdout.trim();
    const sha = await writeSignedCommit(git, bare, {
      tree,
      parents: [],
      author: ident,
      committer: ident,
      message: "heartbeat\n",
      signer,
    });
    expect(await verifyCommits(git, bare, trustPath, [sha])).toEqual({
      [sha]: { status: "good", principal: "daemon:mac" },
    });
  });
});
