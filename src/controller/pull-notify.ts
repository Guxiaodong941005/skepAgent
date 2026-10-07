/**
 * Controller wake-up (D26).
 *
 * The controller is the one device that can reach the others (SSH, or any later channel that
 * can run one command). After it publishes, it tells each worker to fetch. The message carries
 * no event, no signature material and no provider credential (D19): the worker runs `git fetch`
 * and verifies the signed log itself. A worker that misses the message still catches up on its
 * own poll.
 */

import type { DeviceConfig } from "../core/schemas/config.js";
import { execFileChecked } from "../util/exec.js";

export interface WorkerTarget {
  device: string;
  ssh: string;
  skepBin?: string;
  home?: string;
}

export interface PullNotifyResult {
  device: string;
  ok: boolean;
  detail: string;
}

/** One remote command: fetch the blackboard now. No shell on the far side. */
export function pullCommand(worker: WorkerTarget): string[] {
  const bin = worker.skepBin ?? "skep";
  const args = [bin, "pull"];
  if (worker.home) args.push("--home", worker.home);
  return args;
}

/**
 * Tell every configured worker to fetch. Failures are reported, never thrown: a down worker
 * must not fail the publish that already landed on the blackboard.
 */
export async function notifyWorkers(
  workers: readonly WorkerTarget[],
  exec: typeof execFileChecked = execFileChecked,
): Promise<PullNotifyResult[]> {
  const results: PullNotifyResult[] = [];
  for (const worker of workers) {
    const remote = pullCommand(worker);
    try {
      // argv, not a shell string: skep_bin and home are schema-restricted, and ssh
      // receives them as one remote command only because OpenSSH requires that form.
      // The values cannot contain spaces or shell metacharacters (config schema).
      await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", worker.ssh, ...remote], {
        timeoutMs: 20_000,
      });
      results.push({ device: worker.device, ok: true, detail: "fetch requested" });
    } catch (error) {
      results.push({
        device: worker.device,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function workersOf(config: DeviceConfig): WorkerTarget[] {
  return (config.workers ?? []).map((worker) => ({
    device: worker.device,
    ssh: worker.ssh,
    ...(worker.skep_bin ? { skepBin: worker.skep_bin } : {}),
    ...(worker.home ? { home: worker.home } : {}),
  }));
}
