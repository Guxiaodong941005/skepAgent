import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePrincipal } from "../../src/core/principal.js";
import { RelPathSchema, ShaSchema } from "../../src/core/schemas/common.js";
import { buildCommitText, writeSignedCommit, writeTreeFromIndex } from "../../src/git/commit.js";
import { type GitRunner, NodeGitRunner } from "../../src/git/runner.js";
import type { Signer } from "../../src/git/signer.js";

const execFileAsync = promisify(execFile);
const scratchDir = fileURLToPath(new URL("../../.skep-sim/", import.meta.url));

export async function tempDir(prefix: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new TypeError("Invalid temporary directory prefix");
  await mkdir(scratchDir, { recursive: true });
  return mkdtemp(join(scratchDir, prefix));
}

export async function initRepo(dir: string, opts: { bare?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const git = new NodeGitRunner();
  const run = (args: string[]) =>
    git.run(args, {
      cwd: dir,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  await run(["init", "--initial-branch=main", ...(opts.bare ? ["--bare"] : []), "."]);
  await run(["config", "user.name", "Skep Test"]);
  await run(["config", "user.email", "skep-test@example.invalid"]);
  await run(["config", "core.hooksPath", "/dev/null"]);
  await run(["config", "commit.gpgsign", "false"]);
}

export async function generateKey(
  dir: string,
  name: string,
): Promise<{ privPath: string; pubPath: string; pubLine: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError("Invalid test key name");
  await mkdir(dir, { recursive: true });
  const privPath = resolve(dir, name);
  const pubPath = `${privPath}.pub`;
  await execFileAsync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", `test-${name}`, "-f", privPath],
    { shell: false },
  );
  return { privPath, pubPath, pubLine: (await readFile(pubPath, "utf8")).trim() };
}

export async function writeAllowedSigners(
  path: string,
  entries: { principal: string; pubLine: string }[],
): Promise<void> {
  for (const entry of entries) {
    if (
      parsePrincipal(entry.principal) === null ||
      /[\r\n\0]/.test(entry.principal + entry.pubLine)
    ) {
      throw new TypeError("Invalid allowed signers fixture entry");
    }
  }
  await writeFile(
    path,
    entries.map(({ principal, pubLine }) => `${principal} namespaces="git" ${pubLine}\n`).join(""),
    { mode: 0o600 },
  );
}

export async function commitFile(
  git: GitRunner,
  dir: string,
  path: string,
  content: string,
  signer?: Signer,
): Promise<string> {
  RelPathSchema.parse(path);
  const file = resolve(dir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await git.run(["add", "--", path], { cwd: dir });
  const head = await git.run(["rev-parse", "--verify", "HEAD"], { cwd: dir, allowFailure: true });
  const parents = head.code === 0 ? [ShaSchema.parse(head.stdout.trim())] : [];
  const ident = {
    name: "Skep Test",
    email: "skep-test@example.invalid",
    timestampSec: 1_791_244_800,
    tz: "+0000",
  };
  const fields = {
    tree: await writeTreeFromIndex(git, dir),
    parents,
    author: ident,
    committer: ident,
    message: `Test ${path}\n`,
  };
  const sha = signer
    ? await writeSignedCommit(git, dir, { ...fields, signer })
    : ShaSchema.parse(
        (
          await git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
            cwd: dir,
            input: buildCommitText(fields),
          })
        ).stdout.trim(),
      );
  await git.run(
    ["update-ref", "HEAD", sha, ...(parents.length > 0 ? parents : ["0".repeat(sha.length)])],
    { cwd: dir },
  );
  return sha;
}
