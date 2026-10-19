import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { z } from "zod";
import type { Clock } from "../util/clock.js";

const DestinationSchema = z
  .string()
  .max(255)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
const AddressSchema = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
});
export type SshSpawner = (
  file: string,
  args: string[],
  options: { shell: false; env: NodeJS.ProcessEnv; stdio: "pipe" },
) => ChildProcessWithoutNullStreams;

export class SshError extends Error {
  override readonly name = "SshError";
}

export function sshDestination(value: string): string {
  const parsed = DestinationSchema.safeParse(value);
  if (!parsed.success)
    throw new SshError(
      "--via-ssh must be [user@]host (use an SSH config alias for ports or other options)",
    );
  return parsed.data;
}

export interface SshTunnel {
  stream: Duplex;
  /** Reverse forwarding waits for OpenSSH to report its allocated loopback port. */
  ready: Promise<number | null>;
  /** Null means this side deliberately stopped the process. Never rejects. */
  closed: Promise<SshError | null>;
  failure(): SshError | null;
  close(): void;
}

/** SSH only transports the existing encrypted session; key/auth handling stays with OpenSSH. */
export function openSsh(options: {
  destination: string;
  target: { host: string; port: number };
  reverse?: boolean;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  spawn?: SshSpawner;
}): SshTunnel {
  const dest = sshDestination(options.destination);
  const target = AddressSchema.parse(options.target);
  const at = `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ExitOnForwardFailure=yes",
  ];
  if (options.reverse) args.push("-N", "-R", `127.0.0.1:0:${at}`);
  else args.push("-W", at);
  args.push(dest);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawn ?? spawn)("ssh", args, {
      shell: false,
      env: options.env,
      stdio: "pipe",
    });
  } catch (error) {
    throw spawnError(error);
  }
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  // A process can fail before the session attaches its own listener.
  stream.on("error", () => {});
  let stopping = false;
  let settled = false;
  let stderr = "";
  let failure: SshError | null = null;
  let ready = false;
  let resolveReady: (port: number | null) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyPromise = new Promise<number | null>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed: (error: SshError | null) => void = () => {};
  const closed = new Promise<SshError | null>((resolve) => {
    resolveClosed = resolve;
  });
  const timeout = new AbortController();
  const finish = (error: SshError | null): void => {
    if (settled) return;
    settled = true;
    failure = error;
    timeout.abort();
    if (!ready) rejectReady(error ?? new SshError("SSH tunnel closed before it was ready"));
    resolveClosed(error);
    stream.destroy();
  };
  const connected = (port: number | null): void => {
    if (settled || ready) return;
    ready = true;
    timeout.abort();
    resolveReady(port);
  };
  child.once("spawn", () => {
    if (!options.reverse) connected(null);
  });
  child.once("error", (error) => finish(stopping ? null : spawnError(error)));
  const diagnostic = (code: number | null = null, signal: string | null = null): SshError => {
    const cause = /permission denied|authentication failed/i.test(stderr)
      ? "SSH authentication failed; configure key authentication and test ssh to the host first"
      : /host key verification failed/i.test(stderr)
        ? "SSH host key verification failed; test ssh to the host and verify its host key first"
        : /remote port forwarding failed|administratively prohibited/i.test(stderr)
          ? "SSH forwarding was refused; enable TCP forwarding on the SSH server"
          : `SSH tunnel exited ${code ?? signal ?? "early"}; check the SSH host, key authentication and forwarding settings`;
    return new SshError(cause);
  };
  child.once("close", (code, signal) => finish(stopping ? null : diagnostic(code, signal)));
  child.stderr.on("data", (chunk: Buffer) => {
    // Bounded diagnostics are classified locally; raw SSH text is never session data.
    stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    if (options.reverse) {
      const match = /Allocated port (\d+) for remote forward/.exec(stderr);
      const port = Number(match?.[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) connected(port);
    }
  });
  void options.clock
    .sleep(15_000, timeout.signal)
    .then(() => {
      if (!ready && !settled) {
        finish(
          new SshError(
            "SSH tunnel did not become ready within 15 s; check key authentication and TCP forwarding",
          ),
        );
        child.kill();
      }
    })
    .catch((error: unknown) => {
      if (!timeout.signal.aborted) {
        finish(
          new SshError(
            `SSH readiness timer failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        child.kill();
      }
    });
  return {
    stream,
    ready: readyPromise,
    closed,
    failure: () =>
      failure ??
      (/permission denied|authentication failed|host key verification failed|remote port forwarding failed|administratively prohibited/i.test(
        stderr,
      ) ||
      typeof child.exitCode === "number" ||
      child.signalCode
        ? diagnostic(child.exitCode, child.signalCode)
        : null),
    close: () => {
      if (stopping || settled) return;
      stopping = true;
      child.kill();
      finish(null);
    },
  };
}

function spawnError(error: unknown): SshError {
  return new SshError(
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "SSH client not found; install OpenSSH and ensure ssh is on PATH"
      : `Could not start SSH: ${error instanceof Error ? error.message : String(error)}`,
  );
}
