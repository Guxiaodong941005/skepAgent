/**
 * `skep doctor` — pre-flight, a full replay and the invariant check (PRD §13.3, §15.2).
 *
 * D18: every network step is an outbound probe of a git remote (blackboard and the allowlisted
 * code repos). Nothing dials another device, nothing speaks SSH to a peer, and the optional hint
 * relay is reported as a warning — the system is correct without it (ARCHITECTURE §17).
 * D19: there is no provider check. Step 3 of the PRD list ("provider name + config hash") is
 * dropped; doctor only checks that a pinned agent CLI binary is on `PATH` at the pinned version.
 */

import { access, constants, readdir, readFile, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { loadAgentMd } from "../../config/agent-md.js";
import { loadDeviceConfig } from "../../config/device.js";
import { ConfigError } from "../../config/errors.js";
import type { SkepPaths } from "../../config/paths.js";
import { checkInvariants, type Violation } from "../../core/reducer/invariants.js";
import { replay } from "../../core/reducer/replay.js";
import type { State } from "../../core/reducer/state.js";
import { CHECKS_FILE_PATH, type DeviceConfig } from "../../core/schemas/config.js";
import { parseChecksFile } from "../../exec/checks-file.js";
import { readLog } from "../../git/log-reader.js";
import { NodeGitRunner } from "../../git/runner.js";
import { loadTrustRoot, TrustRootError } from "../../git/trust.js";
import { type Clock, systemClock } from "../../util/clock.js";
import { type ExecResult, execFileChecked } from "../../util/exec.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";

/** One pre-flight or replay finding. `warn` never fails the run (the relay, the clock). */
export type DoctorStatus = "ok" | "fail" | "warn";

export interface DoctorCheck {
  /** Stable id, so a wrapper can match a finding without parsing prose. */
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** Present once the blackboard replayed. Absent when pre-flight could not reach a log. */
  replay?: { tip: string; seq: number; invalid: number };
  violations: Violation[];
}

/** PRD §13.3 step 8: skew beyond this is worth telling the human, never worth failing. */
const CLOCK_WARN_MS = 5 * 60_000;

export interface DoctorDeps {
  exec: typeof execFileChecked;
  /** Outbound `git ls-remote`. Tests point it at local bare repos or a fake. */
  reach: (url: string) => Promise<{ ok: boolean; detail: string }>;
  /** Wall clock for the informational note. Defaults to `systemClock` (PRD §13.3 step 8). */
  clock?: Clock;
  /** Reference wall time in ms to compare against. Defaults to the clock's own `nowMs()`. */
  referenceMs?: number;
  /** Where AGENT.md files live. Defaults to `<home>/roles`. */
  rolesDir?: string;
  /**
   * Optional hint-relay URL (ARCHITECTURE §17.3). `device.toml` has no relay field until SK-701,
   * so the command passes `SKEP_RELAY_URL` when the human set one. Absent means "not configured"
   * and produces no check at all.
   */
  relayUrl?: string;
  /** Minimum free bytes at `home`. Defaults to 1 GiB (PRD §13.3 step 7). */
  minFreeBytes?: number;
}

const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

export function register(program: Command, ctx: CliContext, deps?: Partial<DoctorDeps>): void {
  program
    .command("doctor")
    .description("Run pre-flight checks, a full replay, and the invariant checks")
    .option("--roles-dir <dir>", "directory of role folders, each with an AGENT.md")
    .action(async (opts: { rolesDir?: string }) => {
      const paths = ctx.paths;
      if (!paths) throw new CliError("no_home", "SKEP_HOME was not resolved");
      const report = await runDoctor(paths, {
        exec: execFileChecked,
        reach: gitReach,
        rolesDir: opts.rolesDir,
        clock: systemClock,
        relayUrl: process.env.SKEP_RELAY_URL,
        ...deps,
      });
      const output = ctx.output();
      output.result(report, () => renderHuman(report));
      if (!report.ok) ctx.exitCode = EXIT.error;
    });
}

/**
 * Run every §13.3 check that this device can answer on its own, then replay the blackboard and
 * run `checkInvariants`. A failed check is recorded, not thrown, so the report stays complete.
 */
export async function runDoctor(paths: SkepPaths, deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const device = await checkDevice(paths, checks);
  await checkTrust(paths, device, checks);
  await checkSigningKey(paths, device, checks);
  await checkRoles(deps.rolesDir ?? path.join(paths.home, "roles"), device, deps, checks);
  await checkGitleaks(deps, checks);
  await checkRemotes(device, deps, checks);
  await checkDisk(paths.home, deps.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES, checks);
  checkClock(deps.clock ?? systemClock, deps.referenceMs, checks);

  const replayed = device ? await checkReplay(paths, checks) : undefined;
  const violations = replayed?.violations ?? [];
  for (const violation of violations) {
    checks.push({
      name: `invariant.${violation.code}`,
      status: "fail",
      detail: violation.detail,
    });
  }
  const ok = checks.every((check) => check.status !== "fail");
  return { ok, checks, ...(replayed ? { replay: replayed.summary } : {}), violations };
}

async function checkDevice(paths: SkepPaths, checks: DoctorCheck[]): Promise<DeviceConfig | null> {
  try {
    const device = await loadDeviceConfig(paths.deviceToml);
    checks.push({ name: "device_toml", status: "ok", detail: `device ${device.device}` });
    return device;
  } catch (error) {
    checks.push({ name: "device_toml", status: "fail", detail: describe(error) });
    return null;
  }
}

/**
 * The trust root is the local `allowed_signers`, never the copy in the blackboard repo
 * (PRD §11.2). It must list `daemon:<device>` exactly, so an ID cannot be claimed elsewhere.
 */
async function checkTrust(
  paths: SkepPaths,
  device: DeviceConfig | null,
  checks: DoctorCheck[],
): Promise<void> {
  let root: Awaited<ReturnType<typeof loadTrustRoot>>;
  try {
    root = await loadTrustRoot(paths.allowedSigners);
  } catch (error) {
    checks.push({ name: "trust_root", status: "fail", detail: describe(error) });
    return;
  }
  if (!device) {
    checks.push({
      name: "trust_root",
      status: "warn",
      detail: "allowed_signers parsed, but device.toml did not, so the principal was not checked",
    });
    return;
  }
  const principal = `daemon:${device.device}`;
  const present = root.entries.some((entry) => entry.principals.includes(principal));
  checks.push(
    present
      ? {
          name: "daemon_principal",
          status: "ok",
          detail: `${principal} is in the local trust root`,
        }
      : {
          name: "daemon_principal",
          status: "fail",
          detail: `${principal} is not in ${paths.allowedSigners}; the controller must install it`,
        },
  );
}

/** The signing key file exists and is mode 0600 or tighter (PRD §11.4: unreadable by the agent user). */
async function checkSigningKey(
  paths: SkepPaths,
  device: DeviceConfig | null,
  checks: DoctorCheck[],
): Promise<void> {
  if (!device) return;
  const keyPath = path.resolve(paths.home, device.signing_key);
  try {
    const info = await stat(keyPath);
    if ((info.mode & 0o077) !== 0) {
      checks.push({
        name: "signing_key",
        status: "fail",
        detail: `${keyPath} is readable by group or other (mode ${(info.mode & 0o777).toString(8)})`,
      });
      return;
    }
  } catch (error) {
    checks.push({ name: "signing_key", status: "fail", detail: describe(error) });
    return;
  }
  checks.push({ name: "signing_key", status: "ok", detail: keyPath });
}

/**
 * Every `<rolesDir>/<role>/AGENT.md` must parse, and the agent user (when one is named by
 * `SKEP_AGENT_USER`) must not be able to write it (PRD §7.3, §13.3 step 2). The pinned CLI is
 * checked for presence and version only — never its provider configuration (D19).
 */
async function checkRoles(
  rolesDir: string,
  device: DeviceConfig | null,
  deps: DoctorDeps,
  checks: DoctorCheck[],
): Promise<void> {
  const dirs = await roleDirs(rolesDir);
  if (dirs.length === 0) {
    checks.push({
      name: "agent_md",
      status: "warn",
      detail: `no role directories under ${rolesDir}`,
    });
    return;
  }
  for (const roleDir of dirs) {
    await checkRole(roleDir, device, deps, checks);
  }
}

async function roleDirs(rolesDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(rolesDir);
  } catch {
    return [];
  }
  return names.sort().map((name) => path.join(rolesDir, name));
}

async function checkRole(
  roleDir: string,
  device: DeviceConfig | null,
  deps: DoctorDeps,
  checks: DoctorCheck[],
): Promise<void> {
  const label = path.basename(roleDir);
  let agent: Awaited<ReturnType<typeof loadAgentMd>>;
  try {
    agent = await loadAgentMd(roleDir);
  } catch (error) {
    checks.push({ name: `agent_md.${label}`, status: "fail", detail: describe(error) });
    return;
  }
  checks.push({ name: `agent_md.${label}`, status: "ok", detail: agent.file });
  await checkAgentWritable(agent.file, deps, checks, label);
  await checkCli(agent.frontMatter.agent_cli, agent.frontMatter.cli_version, deps, checks, label);
  if (device) checkRepoAllowlist(agent, device, checks, label);
  await checkChecksFile(roleDir, checks, label);
}

/**
 * A role may carry a local copy of `.skep/checks.toml`. When it does, it must parse. Absence is
 * fine: the authoritative copy is the one at `base_commit` in the code repo, which is read before
 * a lease and which doctor cannot see without that repo's clone (PRD §13.3 step 6).
 */
async function checkChecksFile(
  roleDir: string,
  checks: DoctorCheck[],
  label: string,
): Promise<void> {
  const file = path.join(roleDir, CHECKS_FILE_PATH);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  try {
    parseChecksFile(text, file);
    checks.push({ name: `checks_file.${label}`, status: "ok", detail: file });
  } catch (error) {
    checks.push({ name: `checks_file.${label}`, status: "fail", detail: describe(error) });
  }
}

/** A writable AGENT.md means the agent user could rewrite its own policy (PRD §7.3). */
async function checkAgentWritable(
  file: string,
  deps: DoctorDeps,
  checks: DoctorCheck[],
  label: string,
): Promise<void> {
  const user = process.env.SKEP_AGENT_USER;
  if (user === undefined || user === "") {
    checks.push({
      name: `agent_user.${label}`,
      status: "warn",
      detail: "SKEP_AGENT_USER is unset, so the agent user's write access was not checked",
    });
    return;
  }
  const writable = await agentCanWrite(file, user, deps);
  checks.push(
    writable
      ? {
          name: `agent_user.${label}`,
          status: "fail",
          detail: `agent user ${user} can write ${file}; AGENT.md must be read-only to it`,
        }
      : { name: `agent_user.${label}`, status: "ok", detail: `${user} cannot write ${file}` },
  );
}

async function agentCanWrite(file: string, user: string, deps: DoctorDeps): Promise<boolean> {
  try {
    const result = await deps.exec("sudo", ["-n", "-u", user, "test", "-w", file], {
      env: { PATH: process.env.PATH ?? "" },
      allowFailure: true,
    });
    return result.code === 0;
  } catch {
    // No passwordless sudo: fall back to the file mode. Group/other write is the failure mode
    // that matters on a single-user device too.
    try {
      const info = await stat(file);
      return (info.mode & 0o022) !== 0;
    } catch {
      return false;
    }
  }
}

/**
 * D19: presence and pinned version only. The CLI's own config directory is never opened, so a
 * provider name, base URL or key cannot leak into this report.
 */
async function checkCli(
  cli: string,
  pinned: string,
  deps: DoctorDeps,
  checks: DoctorCheck[],
  label: string,
): Promise<void> {
  const probe = CLI_VERSION[cli];
  if (!probe) {
    checks.push({ name: `agent_cli.${label}`, status: "fail", detail: `unknown agent cli ${cli}` });
    return;
  }
  let result: ExecResult;
  try {
    result = await deps.exec(cli, probe.args, {
      env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
      allowFailure: true,
      timeoutMs: 10_000,
    });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    checks.push({
      name: `agent_cli.${label}`,
      status: "fail",
      detail: missing
        ? `${cli} is not on PATH; Skep never installs it (pin ${pinned})`
        : describe(error),
    });
    return;
  }
  const reported = probe.version(`${result.stdout}\n${result.stderr}`);
  if (reported === null) {
    checks.push({
      name: `agent_cli.${label}`,
      status: "fail",
      detail: `${cli} did not report a version (wanted ${pinned})`,
    });
    return;
  }
  checks.push(
    reported === pinned
      ? { name: `agent_cli.${label}`, status: "ok", detail: `${cli} ${reported}` }
      : {
          name: `agent_cli.${label}`,
          status: "fail",
          detail: `${cli} is ${reported}, AGENT.md pins ${pinned}`,
        },
  );
}

/** How each supported CLI reports its version. Args only — no config file is read (D19). */
const CLI_VERSION: Record<string, { args: string[]; version: (text: string) => string | null }> = {
  codex: { args: ["--version"], version: firstVersion },
  claude: { args: ["--version"], version: firstVersion },
  pi: { args: ["--version"], version: firstVersion },
};

function firstVersion(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return match?.[1] ?? null;
}

/** AGENT.md repos must be a subset of the device allowlist (PRD §7.3, §11.5). */
function checkRepoAllowlist(
  agent: Awaited<ReturnType<typeof loadAgentMd>>,
  device: DeviceConfig,
  checks: DoctorCheck[],
  label: string,
): void {
  const allowed = new Set(
    device.repos.map((repo) => repo.url.replace(/\/+$/, "").replace(/\.git$/i, "")),
  );
  const missing = agent.frontMatter.repos.filter(
    (repo) => !allowed.has(repo.replace(/\/+$/, "").replace(/\.git$/i, "")),
  );
  checks.push(
    missing.length === 0
      ? {
          name: `repo_allowlist.${label}`,
          status: "ok",
          detail: "every AGENT.md repo is allowlisted",
        }
      : {
          name: `repo_allowlist.${label}`,
          status: "fail",
          detail: `not in the device allowlist: ${missing.join(", ")}`,
        },
  );
}

/** gitleaks guards every publication (PRD §13.3 step 7). Absent is a failure, not a skip. */
async function checkGitleaks(deps: DoctorDeps, checks: DoctorCheck[]): Promise<void> {
  try {
    const result = await deps.exec("gitleaks", ["version"], {
      env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    checks.push(
      result.code === 0
        ? { name: "gitleaks", status: "ok", detail: result.stdout.trim() || "present" }
        : { name: "gitleaks", status: "fail", detail: "gitleaks exited non-zero" },
    );
  } catch (error) {
    checks.push({
      name: "gitleaks",
      status: "fail",
      detail:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "gitleaks is not on PATH"
          : describe(error),
    });
  }
}

/**
 * D18: outbound reachability only. `git ls-remote` against the blackboard and each allowlisted
 * code remote — never an inbound port, never a connection to another device. The relay, when
 * configured, is a warning whichever way it goes: hints are optional (ARCHITECTURE §17.2).
 */
async function checkRemotes(
  device: DeviceConfig | null,
  deps: DoctorDeps,
  checks: DoctorCheck[],
): Promise<void> {
  if (!device) return;
  const blackboard = await deps.reach(device.blackboard.url);
  checks.push({
    name: "blackboard_remote",
    status: blackboard.ok ? "ok" : "fail",
    detail: blackboard.detail,
  });
  for (const repo of device.repos) {
    const reached = await deps.reach(repo.url);
    checks.push({
      name: `code_remote.${repo.name}`,
      status: reached.ok ? "ok" : "fail",
      detail: reached.detail,
    });
  }
  // The relay only ever warns. A hint channel is an optimisation, so an absent or unreachable
  // one must not turn a healthy device into a failed pre-flight (ARCHITECTURE §17.2, D18).
  if (deps.relayUrl !== undefined && deps.relayUrl !== "") {
    const reached = await deps.reach(deps.relayUrl);
    checks.push({
      name: "relay",
      status: "warn",
      detail: reached.ok
        ? `optional hint relay at ${deps.relayUrl} answered; it is not required`
        : `optional hint relay at ${deps.relayUrl} did not answer; hints are not required (D18)`,
    });
  }
}

/** `git ls-remote` is an outbound read. It reports whether the remote is reachable, nothing more. */
async function gitReach(url: string): Promise<{ ok: boolean; detail: string }> {
  const git = new NodeGitRunner();
  try {
    await git.run(["ls-remote", "--heads", url], { cwd: process.cwd(), timeoutMs: 15_000 });
    return { ok: true, detail: `reachable: ${url}` };
  } catch (error) {
    return { ok: false, detail: `unreachable: ${url} (${describe(error)})` };
  }
}

async function checkDisk(dir: string, minFreeBytes: number, checks: DoctorCheck[]): Promise<void> {
  try {
    const info = await statfs(dir);
    const free = Number(info.bavail) * Number(info.bsize);
    checks.push(
      free >= minFreeBytes
        ? { name: "disk", status: "ok", detail: `${free} bytes free` }
        : {
            name: "disk",
            status: "fail",
            detail: `${free} bytes free, want at least ${minFreeBytes}`,
          },
    );
  } catch (error) {
    checks.push({
      name: "disk",
      status: "warn",
      detail: `could not check disk space: ${describe(error)}`,
    });
  }
}

/**
 * Informational only (PRD §13.3 step 8, §8.3): ordering is log position, so a skewed clock cannot
 * change state. With no external reference the check always passes; a caller that has one (tests,
 * a future NTP reading) passes `referenceMs` and a large gap is a warning, never a failure.
 */
function checkClock(clock: Clock, referenceMs: number | undefined, checks: DoctorCheck[]): void {
  const skew = referenceMs === undefined ? 0 : Math.abs(clock.nowMs() - referenceMs);
  checks.push({
    name: "clock",
    status: skew > CLOCK_WARN_MS ? "warn" : "ok",
    detail:
      skew > CLOCK_WARN_MS
        ? `clock differs from the reference by ${Math.round(skew / 1000)}s; informational only, state is unaffected`
        : "clock looks consistent (informational; correctness does not depend on it)",
  });
}

interface ReplayOutcome {
  summary: { tip: string; seq: number; invalid: number };
  violations: Violation[];
}

/** Full replay from genesis, then the pure invariant predicates (PRD §10.1, ARCHITECTURE §13.2). */
async function checkReplay(
  paths: SkepPaths,
  checks: DoctorCheck[],
): Promise<ReplayOutcome | undefined> {
  try {
    await access(path.join(paths.blackboardClone, ".git"), constants.F_OK);
  } catch {
    checks.push({
      name: "replay",
      status: "warn",
      detail: `no blackboard clone at ${paths.blackboardClone}; skipped the full replay`,
    });
    return undefined;
  }
  try {
    const git = new NodeGitRunner();
    const entries = await readLog(git, paths.blackboardClone, paths.allowedSigners);
    const state: State = replay(entries);
    const violations = checkInvariants(entries, state);
    const invalid = state.outcomes.filter((outcome) => outcome.outcome === "invalid").length;
    checks.push({
      name: "replay",
      status: violations.length === 0 ? "ok" : "fail",
      detail: `replayed ${entries.length} commits to seq ${state.seq}, ${invalid} invalid`,
    });
    return {
      summary: { tip: state.tip, seq: state.seq, invalid },
      violations,
    };
  } catch (error) {
    checks.push({ name: "replay", status: "fail", detail: describe(error) });
    return undefined;
  }
}

function describe(error: unknown): string {
  if (
    error instanceof ConfigError ||
    error instanceof TrustRootError ||
    error instanceof CliError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function renderHuman(report: DoctorReport): string {
  const lines = report.checks.map(
    (check) => `${mark(check.status)} ${check.name}: ${check.detail}`,
  );
  lines.push("", report.ok ? "doctor: ok" : "doctor: failed");
  return `${lines.join("\n")}\n`;
}

function mark(status: DoctorStatus): string {
  if (status === "ok") return "ok  ";
  if (status === "warn") return "warn";
  return "fail";
}
