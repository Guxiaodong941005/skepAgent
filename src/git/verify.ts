import { resolve } from "node:path";
import { z } from "zod";
import type { SignatureCheck } from "../core/log.js";
import { parsePrincipal } from "../core/principal.js";
import { ShaSchema } from "../core/schemas/common.js";
import type { GitRunner } from "./runner.js";

export class GitVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitVerificationError";
  }
}

const RecordSchema = z.tuple([ShaSchema, z.string().length(1), z.string(), z.string()]);
const ObjectIdSchema = ShaSchema.refine(
  (sha) => !sha.includes("\n"),
  "object ID cannot contain LF",
);

export async function verifyCommits(
  git: GitRunner,
  repoDir: string,
  trustRootPath: string,
  shas: string[],
): Promise<Record<string, SignatureCheck>> {
  const requestedSet = new Set(z.array(ObjectIdSchema).parse(shas));
  const requested = [...requestedSet];
  if (requested.length === 0) return {};
  // PRD §11.2 / ARCHITECTURE §7.3: repository config cannot select the trust root or verifier.
  const { stdout } = await git.run(
    [
      "--no-replace-objects",
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.allowedSignersFile=${resolve(repoDir, trustRootPath)}`,
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "log",
      "--no-walk",
      "--no-show-signature",
      "--no-color",
      "--no-decorate",
      "--format=%H%x00%G?%x00%GS%x00%GF",
      ...requested,
      "--",
    ],
    { cwd: repoDir },
  );
  const checks: Record<string, SignatureCheck> = {};
  for (const line of stdout.replace(/\n$/, "").split("\n")) {
    const parsed = RecordSchema.safeParse(line.split("\0"));
    if (!parsed.success) {
      throw new GitVerificationError("git log returned a malformed signature record", {
        cause: parsed.error,
      });
    }
    const [sha, status, principal, fingerprint] = parsed.data;
    if (!requestedSet.has(sha) || Object.hasOwn(checks, sha)) {
      throw new GitVerificationError(`git log returned an unexpected or duplicate commit ${sha}`);
    }
    const detail = `git signature status ${status}; principal ${JSON.stringify(principal)}; fingerprint ${fingerprint || "unavailable"}`;
    if (status === "G" && parsePrincipal(principal) !== null) {
      checks[sha] = { status: "good", principal };
    } else if (status === "N") {
      checks[sha] = { status: "missing" };
    } else if (status === "B") {
      checks[sha] = { status: "bad", detail };
    } else {
      checks[sha] = { status: "unknown_key", detail };
    }
  }
  for (const sha of requested) {
    if (!Object.hasOwn(checks, sha)) {
      throw new GitVerificationError(`git log omitted requested commit ${sha}`);
    }
  }
  return checks;
}
