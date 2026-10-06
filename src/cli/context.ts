/**
 * Dependencies a command action may use. Tests pass fake streams so nothing reaches a real TTY
 * or `~/.skep`.
 */

import type { SkepPaths } from "../config/paths.js";
import { connectIpc, type IpcClient } from "../ipc/client.js";
import type { Output } from "./output.js";

export interface CliWritable {
  write(s: string): void;
}

export interface CliContext {
  stdout: CliWritable;
  stderr: CliWritable;
  env: NodeJS.ProcessEnv;
  /** Output bound to the global `--machine` flag of the invocation being parsed. */
  output(): Output;
  /**
   * Resolved paths for this invocation. Set by the preAction hook, so it reflects `--home`
   * overriding `SKEP_HOME`. Undefined until a command action begins.
   */
  paths?: SkepPaths;
  /**
   * Set by an action that has already written its output and must still fail. `runCli` returns
   * it when the action resolves, so the failure does not need a second error frame.
   */
  exitCode?: number;
  /**
   * Open a client to the daemon socket (ARCHITECTURE §12). Commands that publish or query go
   * through it; when the daemon is down they fall back to an in-process publisher (SK-603).
   * Optional: `runCli` fills in {@link connectDaemon} when an action does not supply its own,
   * and tests replace it to avoid a real socket.
   */
  connectDaemon?: () => Promise<IpcClient>;
}

/** A context whose `connectDaemon` talks to `paths.socket`. Paths must already be resolved. */
export function connectDaemon(ctx: CliContext): Promise<IpcClient> {
  const socket = ctx.paths?.socket;
  if (socket === undefined) {
    return Promise.reject(new Error("skep home is not resolved; cannot locate skepd.sock"));
  }
  return connectIpc(socket);
}
