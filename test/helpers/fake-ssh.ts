import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import type { SshSpawner } from "../../src/session/ssh.js";

export function fakeSsh(
  options: { reversePort?: number; error?: string; stderr?: string; exit?: number } = {},
) {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      process.emit("close", null, "SIGTERM");
      return true;
    }),
  });
  const spawn = vi.fn<SshSpawner>(() => {
    queueMicrotask(() => {
      if (options.error) {
        process.emit("error", Object.assign(new Error(options.error), { code: options.error }));
        return;
      }
      process.emit("spawn");
      if (options.reversePort)
        process.stderr.write(
          `Allocated port ${options.reversePort} for remote forward to 127.0.0.1:7419\r\n`,
        );
      if (options.stderr) process.stderr.write(options.stderr);
      if (options.exit !== undefined) process.emit("close", options.exit, null);
    });
    return process as unknown as ChildProcessWithoutNullStreams;
  });
  return { spawn, process };
}
