import { stat } from "node:fs/promises";
import { z } from "zod";
import { ShaSchema } from "../core/schemas/common.js";
import { execFileChecked } from "../util/exec.js";
import { type AgentEnvOptions, agentEnv } from "./sandbox-env.js";

export class SecretScanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretScanError";
  }
}

export interface SecretScanOptions {
  cwd: string;
  baseSha: string;
  headSha: string;
  env: AgentEnvOptions;
  /** Explicit test-only escape hatch. Production requires gitleaks (PRD §13.3). */
  allowMissingForTests?: boolean;
}

export type SecretScanResult =
  | { status: "clean" }
  | { status: "secrets_detected" }
  | { status: "skipped"; warning: string };

const ScanOptionsSchema = z.strictObject({
  cwd: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0")),
  baseSha: ShaSchema,
  headSha: ShaSchema,
  env: z.unknown(),
  allowMissingForTests: z.boolean().optional(),
});

function missingExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as NodeJS.ErrnoException).code === "ENOENT" || missingExecutable(error.cause);
}

/** PRD §9.6/§11.5: scan every new commit in the delivery range, with findings redacted. */
export async function scanSecrets(
  options: SecretScanOptions,
  deps: { exec?: typeof execFileChecked; warn?: (message: string) => void } = {},
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
  try {
    const result = await (deps.exec ?? execFileChecked)(
      "gitleaks",
      [
        "git",
        "--no-banner",
        "--redact",
        "--exit-code=42",
        `--log-opts=${options.baseSha}..${options.headSha}`,
        ".",
      ],
      { cwd: options.cwd, env: agentEnv(options.env), allowFailure: true },
    );
    if (result.code === 0 && result.signal === null && !result.timedOut) return { status: "clean" };
    if (result.code === 42 && result.signal === null && !result.timedOut) {
      return { status: "secrets_detected" };
    }
    throw new SecretScanError(
      "gitleaks could not complete the scan; check its installation and repository",
    );
  } catch (error) {
    if (options.allowMissingForTests && missingExecutable(error)) {
      const warning = "gitleaks is unavailable; secret scanning was skipped for this test only";
      (deps.warn ?? console.warn)(warning);
      return { status: "skipped", warning };
    }
    if (error instanceof SecretScanError) throw error;
    throw new SecretScanError("Cannot run gitleaks; install it before publishing code or events", {
      cause: error,
    });
  }
}
