import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sha } from "../core/ids.js";
import { REDUCER_VERSION } from "../core/reducer/state.js";
import { GENESIS_PATH, type Genesis, GenesisSchema } from "../core/schemas/genesis.js";
import { type Ident, writeSignedCommit, writeTreeFromIndex } from "../git/commit.js";
import type { GitRunner } from "../git/runner.js";
import type { Signer } from "../git/signer.js";
import { parseAllowedSigners } from "../git/trust.js";
import type { BlackboardClone } from "./clone.js";

export class GenesisCreationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Cannot create blackboard genesis: ${message}`, options);
    this.name = "GenesisCreationError";
  }
}

export async function createGenesis(deps: {
  git: GitRunner;
  clone: BlackboardClone;
  signer: Signer;
  genesis: Genesis;
  allowedSignersText: string;
  ident: Ident;
}): Promise<Sha> {
  const { git, clone, signer, allowedSignersText, ident } = deps;
  if (signer.principal !== "human") {
    throw new GenesisCreationError("the root commit requires the human signer");
  }
  const parsed = GenesisSchema.safeParse(deps.genesis);
  if (!parsed.success) throw new GenesisCreationError(parsed.error.message);
  const genesis = parsed.data;
  if (genesis.reducer_version !== REDUCER_VERSION) {
    throw new GenesisCreationError(`expected reducer version ${REDUCER_VERSION}`);
  }
  const { errors } = parseAllowedSigners(allowedSignersText);
  if (errors.length > 0) throw new GenesisCreationError(errors.join("; "));
  try {
    await clone.init();
    const remote = await git.run(["ls-remote", "--heads", "origin", "refs/heads/main"], {
      cwd: clone.dir,
    });
    if (remote.stdout.trim() !== "") {
      throw new GenesisCreationError("remote main already exists; use the existing blackboard");
    }
    // Genesis alone is a multi-file root (§5.3). The repository's policy copy is audit data;
    // fullReplaySource always verifies with its caller's local trustPath (§7.3).
    await git.run(["read-tree", "--empty"], { cwd: clone.dir });
    await mkdir(join(clone.dir, "policy"), { recursive: true });
    await writeFile(join(clone.dir, GENESIS_PATH), `${JSON.stringify(genesis, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(join(clone.dir, "policy/allowed_signers.txt"), allowedSignersText, {
      mode: 0o600,
    });
    await git.run(["add", "--", GENESIS_PATH, "policy/allowed_signers.txt"], { cwd: clone.dir });
    const sha = await writeSignedCommit(git, clone.dir, {
      tree: await writeTreeFromIndex(git, clone.dir),
      parents: [],
      author: ident,
      committer: ident,
      message: `genesis ${genesis.blackboard_id}`,
      signer,
    });
    await git.run(["update-ref", "refs/heads/main", sha, "0".repeat(sha.length)], {
      cwd: clone.dir,
    });
    // Concurrent bootstrap attempts are arbitrated by the same plain push as every event (§7.2).
    await git.run(["push", "origin", `${sha}:refs/heads/main`], { cwd: clone.dir });
    return sha;
  } catch (error) {
    if (error instanceof GenesisCreationError) throw error;
    throw new GenesisCreationError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
