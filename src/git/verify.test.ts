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
import { type GitRunner, NodeGitRunner } from "./runner.js";
import { SshKeySigner } from "./signer.js";
import { GitVerificationError, verifyCommits } from "./verify.js";

describe("real git signature verification", () => {
  const git = new NodeGitRunner();
  let root: string;
  let repo: string;
  let key: Awaited<ReturnType<typeof generateKey>>;
  let unknownKey: Awaited<ReturnType<typeof generateKey>>;
  let signer: SshKeySigner;
  let unknownSigner: SshKeySigner;
  let trustPath: string;

  beforeAll(async () => {
    root = await tempDir("verify-");
    vi.stubEnv("HOME", root);
    key = await generateKey(root, "daemon");
    unknownKey = await generateKey(root, "unknown");
    signer = new SshKeySigner({ principal: "daemon:mac", keyPath: key.privPath });
    unknownSigner = new SshKeySigner({ principal: "daemon:other", keyPath: unknownKey.privPath });
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

  it("classifies good, unsigned, unknown-key and tampered commits in one process (AC 1–2)", async () => {
    const unsigned = await commitFile(git, repo, "unsigned.txt", "unsigned\n");
    const good = await commitFile(git, repo, "good.txt", "good\n", signer);
    const unknown = await commitFile(git, repo, "unknown.txt", "unknown\n", unknownSigner);
    const object = (await git.run(["cat-file", "-p", good], { cwd: repo })).stdout;
    const tamperedObject = object.replace("\n\nTest good.txt\n", "\n\nTampered message\n");
    expect(tamperedObject).not.toBe(object);
    const bad = (
      await git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
        cwd: repo,
        input: tamperedObject,
      })
    ).stdout.trim();
    const run = vi.fn(git.run.bind(git));
    const checks = await verifyCommits({ run }, repo, trustPath, [good, unsigned, unknown, bad]);
    expect(checks).toEqual({
      [good]: { status: "good", principal: "daemon:mac" },
      [unsigned]: { status: "missing" },
      [unknown]: { status: "unknown_key", detail: expect.stringMatching(/status [UE]/) },
      [bad]: { status: "bad", detail: expect.stringContaining("status B") },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("overrides repository-local attacker trust and ignores the repo policy file (AC 3)", async () => {
    const good = await commitFile(git, repo, "good.txt", "good\n", signer);
    const forged = await commitFile(
      git,
      repo,
      "policy/allowed_signers.txt",
      `human namespaces="git" ${unknownKey.pubLine}\n`,
      unknownSigner,
    );
    const attackerPath = join(repo, "policy", "allowed_signers.txt");
    await git.run(["config", "gpg.format", "ssh"], { cwd: repo });
    await git.run(["config", "gpg.ssh.allowedSignersFile", attackerPath], { cwd: repo });
    const direct = await git.run(["verify-commit", forged], { cwd: repo });
    expect(direct.code).toBe(0);
    expect(await verifyCommits(git, repo, trustPath, [good, forged])).toEqual({
      [good]: { status: "good", principal: "daemon:mac" },
      [forged]: { status: "unknown_key", detail: expect.any(String) },
    });
  });

  it("accepts stock SSH-signed git commit -S identically (AC 4)", async () => {
    await commitFile(git, repo, "base.txt", "base\n");
    await writeFile(join(repo, "stock.txt"), "stock\n");
    await git.run(["add", "stock.txt"], { cwd: repo });
    await git.run(
      [
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${key.privPath}`,
        "commit",
        "-S",
        "-m",
        "stock SSH commit",
      ],
      {
        cwd: repo,
        env: { GIT_AUTHOR_DATE: "1791244800 +0000", GIT_COMMITTER_DATE: "1791244800 +0000" },
      },
    );
    const sha = (await git.run(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const plumbing = await commitFile(git, repo, "plumbing.txt", "plumbing\n", signer);
    const checks = await verifyCommits(git, repo, trustPath, [sha, plumbing]);
    expect(checks[sha]).toEqual({ status: "good", principal: "daemon:mac" });
    expect(checks[sha]).toEqual(checks[plumbing]);
  });

  it("rejects a cryptographically valid signer whose principal is outside the protocol", async () => {
    const sha = await commitFile(git, repo, "event.txt", "event\n", signer);
    const invalidTrust = join(root, "invalid-principal-signers");
    await writeFile(invalidTrust, `administrator namespaces="git" ${key.pubLine}\n`);
    expect((await verifyCommits(git, repo, invalidTrust, [sha]))[sha]).toEqual({
      status: "unknown_key",
      detail: expect.stringContaining("status G"),
    });
  });

  it("honors namespace restrictions in the supplied local trust file", async () => {
    const sha = await commitFile(git, repo, "event.txt", "event\n", signer);
    const otherNamespace = join(root, "other-namespace-signers");
    await writeFile(otherNamespace, `daemon:mac namespaces="other" ${key.pubLine}\n`);
    expect((await verifyCommits(git, repo, otherNamespace, [sha]))[sha]).toEqual({
      status: "bad",
      detail: expect.stringContaining("status B"),
    });
  });

  it("fails closed if the local trust file is missing", async () => {
    const sha = await commitFile(git, repo, "event.txt", "event\n", signer);
    expect((await verifyCommits(git, repo, join(root, "missing"), [sha]))[sha]?.status).toBe(
      "unknown_key",
    );
  });
});

describe("verification output parsing", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const runner = (stdout: string): GitRunner => ({
    run: vi.fn(async () => ({ code: 0, stdout, stderr: "" })),
  });

  it.each(["U", "E", "X", "Y", "R", "?"])(
    "fails closed on status %s and includes the letter in diagnostics",
    async (letter) => {
      const checks = await verifyCommits(
        runner(`${sha}\0${letter}\0daemon:mac\0SHA256:test\n`),
        "/repo",
        "/local/signers",
        [sha],
      );
      expect(checks[sha]).toEqual({
        status: "unknown_key",
        detail: expect.stringContaining(`status ${letter}`),
      });
    },
  );

  it.each(["", "invalid", "daemon:MAC", "human "])(
    "fails closed on a G result with unparseable principal %j",
    async (principal) => {
      const checks = await verifyCommits(
        runner(`${sha}\0G\0${principal}\0fingerprint\n`),
        "/repo",
        "/local/signers",
        [sha],
      );
      expect(checks[sha]).toEqual({
        status: "unknown_key",
        detail: expect.stringContaining("status G"),
      });
    },
  );

  it("does not invoke git for an empty list", async () => {
    const git = runner("");
    expect(await verifyCommits(git, "/repo", "/local/signers", [])).toEqual({});
    expect(git.run).not.toHaveBeenCalled();
  });

  it("deduplicates SHAs and resolves a relative trust path against the repository", async () => {
    const git = runner(`${sha}\0G\0human\0fingerprint\n`);
    expect(await verifyCommits(git, "/repo", "local/signers", [sha, sha])).toEqual({
      [sha]: { status: "good", principal: "human" },
    });
    expect(git.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "gpg.format=ssh",
        "gpg.ssh.allowedSignersFile=/repo/local/signers",
        "gpg.ssh.program=ssh-keygen",
        "--no-walk",
        "--format=%H%x00%G?%x00%GS%x00%GF",
      ]),
      { cwd: "/repo" },
    );
  });

  it.each([
    "",
    "malformed\n",
    `${sha}\0G\0human\n`,
    `${other}\0N\0\0\n`,
    `${sha}\0N\0\0\n${sha}\0N\0\0\n`,
  ])("rejects malformed, unexpected or duplicate records: %j", async (stdout) => {
    await expect(
      verifyCommits(runner(stdout), "/repo", "/local/signers", [sha]),
    ).rejects.toBeInstanceOf(GitVerificationError);
  });

  it("rejects incomplete batches", async () => {
    await expect(
      verifyCommits(runner(`${sha}\0N\0\0\n`), "/repo", "/local/signers", [sha, other]),
    ).rejects.toThrow(`omitted requested commit ${other}`);
  });

  it.each(["--all", `${sha}\n`])("validates object ID %j before invoking git", async (invalid) => {
    const git = runner("");
    await expect(verifyCommits(git, "/repo", "/local/signers", [invalid])).rejects.toThrow();
    expect(git.run).not.toHaveBeenCalled();
  });
});
