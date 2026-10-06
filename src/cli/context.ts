/**
 * Dependencies a command action may use. Tests pass fake streams so nothing reaches a real TTY
 * or `~/.skep`.
 */

import type { SkepPaths } from "../config/paths.js";
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
}
