import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
import type { Evidence, FileSpanEvidence } from "../core/schemas/evidence.js";
import { NodeGitRunner } from "../git/runner.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { EvidenceError, EvidenceVerifier } from "./evidence.js";
import { type AttemptKey, Journal } from "./journal.js";
import { CodeMirror } from "./worktree.js";

const attempt: AttemptKey = { task: "T-20261006-abcd", item: "W1", epoch: 1 };
const sha = "a".repeat(40);
const logSha = sha256Hex("example log\n");
const argvSha = sha256Hex(canonicalJson(["example-check", "literal argument"]));

describe("pinned file evidence", () => {
  const git = new NodeGitRunner();
  let root: string;
  let mirror: CodeMirror;
  let verifier: EvidenceVerifier;
  let baseCommit: string;

  beforeAll(async () => {
    root = await tempDir("file-evidence-");
    const writer = path.join(root, "writer");
    await initRepo(writer);
    baseCommit = await commitFile(git, writer, "example.txt", "first\nsecond\nthird\n");
    await commitFile(git, writer, "example.txt", "changed after base\n");
    await commitFile(git, writer, "empty.txt", "");
    mirror = new CodeMirror({
      git,
      home: path.join(root, "home"),
      worktreeRoot: path.join(root, "worktrees"),
      repos: [{ name: "app", url: writer }],
    });
    await mirror.fetch("app");
    verifier = new EvidenceVerifier({ git, mirror, journal: { read: async () => [] } });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function file(): FileSpanEvidence {
    return {
      id: "ev_file",
      type: "file_span",
      repo: "app",
      commit: baseCommit,
      path: "example.txt",
      lines: [2, 3],
      sha256: sha256Hex("second\nthird"),
      excerpt: "second\nthird",
    };
  }

  it("verifies inclusive lines at the pinned commit rather than the mirror's current branch", async () => {
    expect(await verifier.verify(file(), attempt)).toBe(true);
    const { excerpt: _excerpt, ...withoutExcerpt } = file();
    expect(await verifier.verify(withoutExcerpt, attempt)).toBe(true);
  });

  it.each([
    { excerpt: "tampered excerpt" },
    { sha256: "0".repeat(64) },
    { commit: sha },
    { path: "missing.txt" },
    { repo: "unallowlisted" },
    { lines: [2, 4], excerpt: "second\nthird\n", sha256: sha256Hex("second\nthird\n") },
    { lines: [3, 2] },
    { lines: [0, 1] },
    { path: "../example.txt" },
    { path: "/example.txt" },
    { extra: "unknown keys are rejected" },
  ])("drops invalid or tampered file evidence: %j", async (change) => {
    expect(await verifier.verify({ ...file(), ...change }, attempt)).toBe(false);
  });

  it("does not consider an empty file to have a first line", async () => {
    const dir = await mirror.mirrorPath("app");
    const commit = (
      await git.run(["rev-parse", "refs/remotes/origin/main"], { cwd: dir })
    ).stdout.trim();
    expect(
      await verifier.verify(
        { ...file(), commit, path: "empty.txt", lines: [1, 1], excerpt: "", sha256: sha256Hex("") },
        attempt,
      ),
    ).toBe(false);
  });

  it("reports infrastructure failures instead of treating them as valid evidence", async () => {
    const failed = new EvidenceVerifier({
      git: { run: vi.fn().mockRejectedValue(new Error("cannot execute git")) },
      mirror,
      journal: { read: async () => [] },
    });
    await expect(failed.verify(file(), attempt)).rejects.toThrow(EvidenceError);
  });
});

describe("local journal run evidence", () => {
  const dirs: string[] = [];
  const command = { run_id: "run_command", argv_sha256: argvSha, sha, exit: 1, log_sha256: logSha };
  const check = {
    run_id: "run_check",
    check: "unit",
    sha,
    exit: 1,
    duration_ms: 30,
    passed: 2,
    failed: 1,
    log_sha256: logSha,
    argv_sha256: argvSha,
  };

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await tempDir("journal-evidence-");
    dirs.push(root);
    const journal = new Journal({ roleDir: root, clock: new FakeClock(new VirtualTime()) });
    await journal.append(attempt, { step: "command_run", ...command });
    await journal.append(attempt, { step: "check_started", run_id: check.run_id });
    await journal.append(attempt, { step: "check_run", ...check });
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal,
    });
    return { verifier, journal };
  }

  function commandEvidence(): Evidence {
    return { id: "ev_command", type: "command_run", ...command };
  }

  function checkEvidence(): Evidence {
    const { duration_ms: _duration, argv_sha256: _argv, ...fields } = check;
    return { id: "ev_check", type: "check_run", ...fields };
  }

  it("verifies recorded command and check runs, including failed commands and optional counts", async () => {
    const { verifier } = await setup();
    expect(await verifier.verify(commandEvidence(), attempt)).toBe(true);
    expect(await verifier.verify(checkEvidence(), attempt)).toBe(true);
    const {
      duration_ms: _duration,
      check: _check,
      passed: _passed,
      failed: _failed,
      ...commandFields
    } = check;
    expect(
      await verifier.verify(
        { id: "ev_as_command", type: "command_run", ...commandFields },
        attempt,
      ),
    ).toBe(true);
    const evidence = checkEvidence();
    if (evidence.type !== "check_run") throw new Error("Expected check evidence");
    const { passed: _pass, failed: _fail, ...withoutCounts } = evidence;
    expect(await verifier.verify(withoutCounts, attempt)).toBe(true);
  });

  it.each([
    { run_id: "run_missing" },
    { sha: "b".repeat(40) },
    { exit: 0 },
    { log_sha256: "0".repeat(64) },
    { argv_sha256: "0".repeat(64) },
    { extra: "unknown keys" },
  ])("rejects tampered command facts: %j", async (change) => {
    const { verifier } = await setup();
    expect(await verifier.verify({ ...commandEvidence(), ...change }, attempt)).toBe(false);
  });

  it.each([
    { run_id: "run_missing" },
    { sha: "b".repeat(40) },
    { exit: 0 },
    { log_sha256: "0".repeat(64) },
    { check: "lint" },
    { passed: 3 },
    { failed: 0 },
  ])("rejects tampered check facts: %j", async (change) => {
    const { verifier } = await setup();
    expect(await verifier.verify({ ...checkEvidence(), ...change }, attempt)).toBe(false);
  });

  it("rejects foreign attempts, started-only runs, wrong record kinds and duplicate completions", async () => {
    const { verifier, journal } = await setup();
    expect(await verifier.verify(commandEvidence(), { ...attempt, epoch: 2 })).toBe(false);
    await journal.append(attempt, { step: "check_started", run_id: "run_started" });
    expect(await verifier.verify({ ...checkEvidence(), run_id: "run_started" }, attempt)).toBe(
      false,
    );
    expect(await verifier.verify({ ...checkEvidence(), run_id: command.run_id }, attempt)).toBe(
      false,
    );
    await journal.append(attempt, { step: "command_run", ...command });
    expect(await verifier.verify(commandEvidence(), attempt)).toBe(false);
  });

  it("drops invalid inputs while preserving verified evidence order", async () => {
    const { verifier } = await setup();
    expect(
      await verifier.verifyAll(
        [null, commandEvidence(), { ...checkEvidence(), exit: 0 }, "free text", checkEvidence()],
        attempt,
      ),
    ).toEqual([commandEvidence(), checkEvidence()]);
  });

  it("rejects malformed journal facts and reports journal corruption", async () => {
    const malformed = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: {
        read: async () => [
          { ts_mono: 0, ts_wall: "example", step: "command_run", ...command, exit: "1" },
        ],
      },
    });
    expect(await malformed.verify(commandEvidence(), attempt)).toBe(false);
    const failed = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: { read: vi.fn().mockRejectedValue(new Error("corrupt journal")) },
    });
    await expect(failed.verify(commandEvidence(), attempt)).rejects.toThrow(EvidenceError);
  });
});
