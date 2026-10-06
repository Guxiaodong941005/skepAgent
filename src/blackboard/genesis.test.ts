import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../../test/helpers/git-fixture.js";
import { genesisDoc } from "../../test/helpers/log-builder.js";
import { readLog } from "../git/log-reader.js";
import { NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { BlackboardClone } from "./clone.js";
import { createGenesis, GenesisCreationError } from "./genesis.js";
import { fullReplaySource } from "./publisher.js";

describe("human-signed genesis bootstrap", () => {
  const git = new NodeGitRunner();
  const ident = {
    name: "Human",
    email: "human@example.invalid",
    timestampSec: 1_791_158_400,
    tz: "+0000",
  };
  let root: string;
  let clone: BlackboardClone;
  let human: SshKeySigner;
  let daemon: SshKeySigner;
  let trustPath: string;
  let allowedSignersText: string;

  beforeAll(async () => {
    root = await tempDir("blackboard-genesis-");
    vi.stubEnv("HOME", root);
    const humanKey = await generateKey(root, "human");
    const daemonKey = await generateKey(root, "mac");
    human = new SshKeySigner({ principal: "human", keyPath: humanKey.privPath });
    daemon = new SshKeySigner({ principal: "daemon:mac", keyPath: daemonKey.privPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [{ principal: "human", pubLine: humanKey.pubLine }]);
    // Deliberately omit the human from the repository's audit copy: it must never confer trust.
    allowedSignersText = `daemon:mac namespaces="git" ${daemonKey.pubLine}\n`;
  });

  beforeEach(async () => {
    const dir = await mkdtemp(join(root, "case-"));
    const remote = join(dir, "remote.git");
    await initRepo(remote, { bare: true });
    clone = new BlackboardClone({ git, dir: join(dir, "clone"), remoteUrl: remote });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function options() {
    return { git, clone, signer: human, genesis: genesisDoc(), allowedSignersText, ident };
  }

  it("creates a signed parentless root adding skep.json and the policy audit file", async () => {
    const sha = await createGenesis(options());
    await clone.fetch();
    expect(await clone.resetToRemoteMain()).toBe(sha);
    const entries = await readLog(git, clone.dir, trustPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sha,
      seq: 0,
      parents: [],
      signature: { status: "good", principal: "human" },
    });
    expect(entries[0]?.changes.map((change) => change.path).sort()).toEqual([
      "policy/allowed_signers.txt",
      "skep.json",
    ]);
    expect(await readFile(join(clone.dir, "policy/allowed_signers.txt"), "utf8")).toBe(
      allowedSignersText,
    );
    const state = await fullReplaySource(git, clone.dir, trustPath).replayTo(sha);
    expect(state).toMatchObject({
      blackboard_id: genesisDoc().blackboard_id,
      genesis_sha: sha,
      tip: sha,
      seq: 0,
    });
  });

  it("refuses an existing remote main even from a fresh private clone", async () => {
    const sha = await createGenesis(options());
    const other = new BlackboardClone({
      git,
      dir: join(clone.dir, "../other"),
      remoteUrl: clone.remoteUrl,
    });
    await expect(createGenesis({ ...options(), clone: other })).rejects.toThrow(
      "remote main already exists",
    );
    expect(
      (await git.run(["ls-remote", "--heads", "origin", "refs/heads/main"], { cwd: other.dir }))
        .stdout,
    ).toContain(sha);
  });

  it("refuses daemon signers, unsupported versions and invalid external documents", async () => {
    await expect(createGenesis({ ...options(), signer: daemon })).rejects.toThrow(
      GenesisCreationError,
    );
    await expect(
      createGenesis({ ...options(), genesis: { ...genesisDoc(), reducer_version: 2 } }),
    ).rejects.toThrow("expected reducer version 1");
    await expect(
      createGenesis({
        ...options(),
        genesis: { ...genesisDoc(), extra: true } as ReturnType<typeof genesisDoc>,
      }),
    ).rejects.toThrow(GenesisCreationError);
    await expect(
      createGenesis({ ...options(), allowedSignersText: "untrusted invalid key\n" }),
    ).rejects.toThrow(GenesisCreationError);
  });

  it("allows only one winner when two humans bootstrap the same empty remote", async () => {
    const other = new BlackboardClone({
      git,
      dir: join(clone.dir, "../other"),
      remoteUrl: clone.remoteUrl,
    });
    const results = await Promise.allSettled([
      createGenesis(options()),
      createGenesis({
        ...options(),
        clone: other,
        genesis: { ...genesisDoc(), blackboard_id: "bb_other0001" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await clone.fetch();
    const tip = await clone.resetToRemoteMain();
    expect((await fullReplaySource(git, clone.dir, trustPath).replayTo(tip)).seq).toBe(0);
  });
});
