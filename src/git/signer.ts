import { execFile } from "node:child_process";
import { z } from "zod";
import { parsePrincipal } from "../core/principal.js";

export interface Signer {
  readonly principal: string;
  sign(payload: Uint8Array): Promise<string>;
}

export const SshSignatureSchema = z
  .string()
  .regex(
    /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n?$/,
    "expected an armored SSH signature with LF line endings",
  );

export class SshSigningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshSigningError";
  }
}

export class SshKeySigner implements Signer {
  readonly principal: string;
  private readonly keyPath: string;
  private readonly useAgent: boolean;
  private readonly sshKeygen: string;

  constructor(opts: {
    principal: string;
    keyPath: string;
    useAgent?: boolean;
    sshKeygen?: string;
  }) {
    if (/[\r\n\0]/.test(opts.principal) || parsePrincipal(opts.principal) === null) {
      throw new SshSigningError(`Invalid signer principal ${JSON.stringify(opts.principal)}`);
    }
    this.principal = opts.principal;
    this.keyPath = opts.keyPath;
    this.useAgent = opts.useAgent ?? false;
    this.sshKeygen = opts.sshKeygen ?? "ssh-keygen";
  }

  sign(payload: Uint8Array): Promise<string> {
    const args = ["-Y", "sign", "-n", "git", "-f", this.keyPath];
    if (this.useAgent) args.push("-U");
    const env: Record<string, string> = { LC_ALL: "C", SSH_ASKPASS_REQUIRE: "never" };
    for (const name of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.sshKeygen,
        args,
        { shell: false, encoding: "utf8", env, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new SshSigningError(
                `Cannot sign with SSH key ${this.keyPath}: ${stderr.trim() || error.message}`,
                { cause: error },
              ),
            );
            return;
          }
          const parsed = SshSignatureSchema.safeParse(stdout);
          if (!parsed.success) {
            reject(
              new SshSigningError(`ssh-keygen returned an invalid signature for ${this.keyPath}`, {
                cause: parsed.error,
              }),
            );
            return;
          }
          resolve(parsed.data);
        },
      );
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // An early exit closes stdin; preserve ssh-keygen's diagnostic from the callback.
        if (error.code !== "EPIPE") {
          reject(
            new SshSigningError(`Cannot send signing payload: ${error.message}`, { cause: error }),
          );
        }
      });
      child.stdin?.end(payload);
    });
  }
}
