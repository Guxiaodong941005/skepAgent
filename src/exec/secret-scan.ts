import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RepoRefSchema, ShaSchema } from "../core/schemas/common.js";
import type { GitRunner } from "../git/runner.js";
import { execFileChecked } from "../util/exec.js";
import { type AgentEnvOptions, agentEnv } from "./sandbox-env.js";
import type { CodeMirror } from "./worktree.js";

export class SecretScanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretScanError";
  }
}

export interface SecretScanOptions {
  repo: string;
  /** Agent worktree; the committed range is scanned in the daemon-owned mirror. */
  cwd: string;
  baseSha: string;
  headSha: string;
  /** Existing daemon-owned directory outside the agent worktree, never an agent TMPDIR. */
  scratchDir: string;
  env: AgentEnvOptions;
  /** Explicit test-only escape hatch. Production requires gitleaks (PRD §13.3). */
  allowMissingForTests?: boolean;
}

export type SecretScanResult =
  | { status: "clean" }
  | { status: "secrets_detected" }
  | { status: "skipped"; warning: string };

const ScanOptionsSchema = z.strictObject({
  repo: RepoRefSchema,
  cwd: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0")),
  baseSha: ShaSchema,
  headSha: ShaSchema,
  scratchDir: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0")),
  env: z.unknown(),
  allowMissingForTests: z.boolean().optional(),
});

export interface SecretScanDependencies {
  git: GitRunner;
  mirror: Pick<CodeMirror, "mirrorPath">;
  exec?: typeof execFileChecked;
  warn?: (message: string) => void;
}

async function trustedFile(
  git: GitRunner,
  mirrorDir: string,
  baseSha: string,
  file: string,
  fallback: string,
): Promise<string> {
  // ls-tree distinguishes an absent file from an unavailable commit or failed Git read.
  const entry = await git.run(["ls-tree", "-z", baseSha, "--", file], {
    cwd: mirrorDir,
    allowFailure: true,
  });
  if (entry.code !== 0) {
    throw new SecretScanError("Cannot read secret scan configuration; fetch the base commit first");
  }
  if (entry.stdout === "") return fallback;
  if (
    !/^100(?:644|755) blob (?:[0-9a-f]{40}|[0-9a-f]{64})\t/.test(entry.stdout) ||
    !entry.stdout.endsWith(`\t${file}\0`)
  ) {
    throw new SecretScanError(`Trusted ${file} must be a regular file at the base commit`);
  }
  const result = await git.run(["show", `${baseSha}:${file}`], {
    cwd: mirrorDir,
    allowFailure: true,
  });
  if (result.code !== 0) throw new SecretScanError(`Cannot read trusted ${file} from the mirror`);
  return result.stdout;
}

function missingExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as NodeJS.ErrnoException).code === "ENOENT" || missingExecutable(error.cause);
}

/** PRD §9.6/§11.5: scan every new commit in the delivery range, with findings redacted. */
export async function scanSecrets(
  options: SecretScanOptions,
  deps: SecretScanDependencies,
): Promise<SecretScanResult> {
  if (!ScanOptionsSchema.safeParse(options).success) {
    throw new SecretScanError(
      "Secret scanning requires a working directory and pinned commit SHAs",
    );
  }
  // ENOENT for a missing cwd is an error, never an unavailable-scanner test skip.
  const info = await stat(options.cwd).catch((error: unknown) => {
    throw new SecretScanError("Cannot access the secret scan directory", { cause: error });
  });
  if (!info.isDirectory()) throw new SecretScanError("Secret scan cwd must be a directory");
  let scratch: string | undefined;
  let invokingScanner = false;
  try {
    const [cwd, scratchRoot] = await Promise.all([
      realpath(options.cwd),
      realpath(options.scratchDir),
    ]);
    const relative = path.relative(cwd, scratchRoot);
    if (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    ) {
      throw new SecretScanError(
        "Secret scan scratch directory must be daemon-owned and outside the worktree",
      );
    }
    const mirrorDir = await deps.mirror.mirrorPath(options.repo);
    const config = await trustedFile(
      deps.git,
      mirrorDir,
      options.baseSha,
      ".gitleaks.toml",
      "[extend]\nuseDefault = true\n",
    );
    const ignore = await trustedFile(deps.git, mirrorDir, options.baseSha, ".gitleaksignore", "");
    scratch = await mkdtemp(path.join(scratchRoot, "gitleaks-"));
    const configPath = path.join(scratch, "config.toml");
    const ignorePath = path.join(scratch, ".gitleaksignore");
    await writeFile(configPath, config, { mode: 0o600, flag: "wx" });
    await writeFile(ignorePath, ignore, { mode: 0o600, flag: "wx" });
    const env = agentEnv(options.env);
    delete env.GITLEAKS_CONFIG;
    delete env.GITLEAKS_CONFIG_TOML;
    // Gitleaks 8.30.1 also reads the source's default ignore file despite an explicit path.
    // A daemon-owned mirror source and private cwd keep every fallback outside agent control
    // (PRD §11.5); worktree commits already live in the mirror's shared object database (§7.5).
    invokingScanner = true;
    const result = await (deps.exec ?? execFileChecked)(
      "gitleaks",
      [
        "git",
        "--no-banner",
        "--redact",
        "--exit-code=42",
        "--config",
        configPath,
        "--gitleaks-ignore-path",
        ignorePath,
        "--ignore-gitleaks-allow",
        `--log-opts=${options.baseSha}..${options.headSha}`,
        mirrorDir,
      ],
      { cwd: scratch, env, allowFailure: true },
    );
    if (result.code === 0 && result.signal === null && !result.timedOut) return { status: "clean" };
    if (result.code === 42 && result.signal === null && !result.timedOut) {
      return { status: "secrets_detected" };
    }
    throw new SecretScanError(
      "gitleaks could not complete the scan; check its installation and repository",
    );
  } catch (error) {
    if (invokingScanner && options.allowMissingForTests && missingExecutable(error)) {
      const warning = "gitleaks is unavailable; secret scanning was skipped for this test only";
      (deps.warn ?? console.warn)(warning);
      return { status: "skipped", warning };
    }
    if (error instanceof SecretScanError) throw error;
    throw new SecretScanError("Cannot run gitleaks; install it before publishing code or events", {
      cause: error,
    });
  } finally {
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => {
        throw new SecretScanError("Cannot remove the daemon-owned secret scan files", {
          cause: error,
        });
      });
    }
  }
}
