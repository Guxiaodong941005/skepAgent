/**
 * `skep init` — provision this device from its own console (ARCHITECTURE §17.6, PRD §15.2).
 *
 * Writes `device.toml`, generates the daemon signing key and prints the `allowed_signers` line
 * for the controller's trust root. No inbound connection is made or required (D18): the human
 * carries the printed public-key line to the controller by any channel. The private key never
 * leaves this device, and nothing here reads or records a provider credential (D19).
 *
 * `--genesis` bootstraps the blackboard (human-signed `skep.json`, ARCHITECTURE §7.1) and is
 * therefore only for the controller, which holds the human key.
 */

import { access, chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { stringify as stringifyToml } from "smol-toml";
import { BlackboardClone } from "../../blackboard/clone.js";
import { createGenesis } from "../../blackboard/genesis.js";
import { REDUCER_VERSION } from "../../core/reducer/state.js";
import type { Genesis } from "../../core/schemas/genesis.js";
import type { Ident } from "../../git/commit.js";
import { NodeGitRunner } from "../../git/runner.js";
import { SshKeySigner, SshSigningError } from "../../git/signer.js";
import { type Clock, isoUtc, systemClock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import { parseDeviceName } from "../validate.js";

const DAEMON_KEY_NAME = "daemon";
/** OpenSSH allowed_signers namespace for git signatures (PRD §11.2). */
const GIT_NAMESPACE = "git";

interface InitOptions {
  device: string;
  blackboard: string;
  genesis?: boolean;
  humanKey?: string;
  blackboardId?: string;
  createdAt?: string;
  repos?: string[];
  notifyUrl?: string;
}

interface GeneratedKey {
  privPath: string;
  pubPath: string;
  /** `ssh-ed25519 AAAA… comment`, exactly as `ssh-keygen` wrote it. */
  pubLine: string;
}

interface InitResult {
  device: string;
  device_toml: string;
  signing_key: string;
  public_key: string;
  /** The daemon line the controller appends to its trust root (PRD §11.2). */
  allowed_signers_line: string;
  /**
   * The exact `allowed_signers` text (human line, then daemon line) a genesis needs locally.
   * Null when no human key was given. Written to disk only when the file is absent.
   */
  allowed_signers: string | null;
  genesis_sha: string | null;
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("init")
    .description("Set up this device: write device.toml, generate the daemon key")
    .requiredOption("--device <name>", "device name", parseDeviceName)
    .requiredOption("--blackboard <url>", "blackboard remote url")
    .option(
      "--genesis",
      "create the blackboard's human-signed genesis commit (controller only, needs --human-key)",
    )
    .option("--human-key <path>", "human signing key, required with --genesis")
    .option("--blackboard-id <id>", "blackboard id for --genesis (bb_<4-40 lowercase alnum>)")
    .option("--created-at <iso>", "genesis timestamp (ISO-8601 UTC); default: now")
    .option(
      "--repo <name=url>",
      "allowlisted code repo (repeatable)",
      (value: string, prev: string[]) => {
        parseRepos([value]);
        return [...prev, value];
      },
      [] as string[],
    )
    .option("--notify-url <url>", "ntfy topic URL for human notifications")
    .action(async (opts: InitOptions) => {
      const paths = requirePaths(ctx);
      const result = await initDevice(
        {
          paths,
          device: opts.device,
          blackboardUrl: opts.blackboard,
          repos: parseRepos(opts.repos ?? []),
          notifyUrl: opts.notifyUrl,
          genesis: opts.genesis === true,
          humanKeyPath: opts.humanKey,
          blackboardId: opts.blackboardId,
          createdAt: opts.createdAt,
        },
        { exec: execFileChecked, clock: systemClock },
      );
      ctx.output().result(result, () => renderHuman(result));
    });
}

export interface InitPaths {
  home: string;
  deviceToml: string;
  /** Local trust root. Genesis writes it when it is absent (PRD §11.2). */
  allowedSigners: string;
  keysDir: string;
  blackboardClone: string;
}

export interface InitRequest {
  paths: InitPaths;
  device: string;
  blackboardUrl: string;
  repos: { name: string; url: string }[];
  notifyUrl?: string;
  genesis: boolean;
  humanKeyPath?: string;
  blackboardId?: string;
  /** ISO-8601 UTC. Defaults to the clock's wall time; tests pass a fixed value. */
  createdAt?: string;
}

/** What `init` needs from the OS. Tests substitute both so no key material or git is required. */
export interface InitDeps {
  exec: typeof execFileChecked;
  /** Override the daemon key step (tests). Production shells out to `ssh-keygen`. */
  generateKey?: (dir: string) => Promise<GeneratedKey>;
  createGenesis?: typeof createGenesis;
  /** Wall time for the genesis `created_at`. Defaults to `systemClock`. */
  clock?: Clock;
}

/**
 * Provision the device. Refuses to overwrite an existing `device.toml` or daemon key: a second
 * init would orphan the public key already installed in the controller's trust root (PRD §11.2).
 */
export async function initDevice(req: InitRequest, deps: InitDeps): Promise<InitResult> {
  if (req.blackboardUrl.trim() === "" || /[\0\r\n]/.test(req.blackboardUrl)) {
    throw new CliError("invalid_blackboard", "the blackboard URL must be a single nonempty line");
  }
  if (req.genesis && (req.humanKeyPath === undefined || req.humanKeyPath === "")) {
    throw new CliError(
      "human_key_required",
      "--genesis creates the human-signed blackboard root and needs --human-key",
    );
  }
  // `--genesis` on an already provisioned device reuses the key and device.toml. A failed
  // genesis used to strand the device: the re-run refused because the key existed, with no way to
  // retry just the blackboard root (review note 2).
  const existing = await deviceAlreadyProvisioned(req.paths);
  if (existing && !req.genesis) {
    throw new CliError(
      "already_initialized",
      "device.toml already exists; refusing to overwrite it. To retry a failed genesis, re-run `skep init` with the same --device, --blackboard and --genesis --human-key",
    );
  }
  const key = existing
    ? await readDaemonKey(req.paths.keysDir)
    : await generateDaemonKey(req.paths.keysDir, deps);
  if (!existing) await writeDeviceToml(req.paths.deviceToml, deviceDocument(req, key.privPath));

  const trust = await localTrustText(req, key);
  if (trust !== null) await writeTrustRoot(req.paths.allowedSigners, trust);

  let genesisSha: string | null = null;
  if (req.genesis && req.humanKeyPath !== undefined) {
    genesisSha = await bootstrapGenesis(req, key, deps);
  }

  return {
    device: req.device,
    device_toml: req.paths.deviceToml,
    signing_key: key.privPath,
    public_key: key.pubLine,
    allowed_signers_line: allowedSignersLine(req.device, key.pubLine),
    allowed_signers: trust,
    genesis_sha: genesisSha,
  };
}

/** True when a previous init wrote device.toml. The key is then reused, never regenerated. */
async function deviceAlreadyProvisioned(paths: InitPaths): Promise<boolean> {
  try {
    await access(paths.deviceToml);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CliError(
      "init_failed",
      `could not check ${paths.deviceToml}: ${(error as Error).message}`,
    );
  }
  return true;
}

/** The daemon key a previous init minted. A retry must not replace it (PRD §11.2). */
async function readDaemonKey(keysDir: string): Promise<GeneratedKey> {
  const privPath = path.join(keysDir, DAEMON_KEY_NAME);
  const pubPath = `${privPath}.pub`;
  let pubLine: string;
  try {
    pubLine = (await readFile(pubPath, "utf8")).trim();
  } catch (error) {
    throw new CliError(
      "already_initialized",
      `device.toml exists but ${pubPath} is missing, so the genesis cannot be retried: ${(error as Error).message}`,
    );
  }
  if (!pubLine.startsWith("ssh-ed25519 ")) {
    throw new CliError("already_initialized", `${pubPath} is not an ed25519 public key`);
  }
  return { privPath, pubPath, pubLine };
}

/** `daemon:<device> namespaces="git" ssh-ed25519 AAAA… comment` (PRD §11.2). */
export function allowedSignersLine(device: string, pubLine: string): string {
  return `daemon:${device} namespaces="${GIT_NAMESPACE}" ${pubLine}`;
}

function deviceDocument(req: InitRequest, signingKey: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schema: "skep.device/v1",
    device: req.device,
    signing_key: signingKey,
    blackboard: { url: req.blackboardUrl },
    repos: req.repos,
  };
  if (req.notifyUrl !== undefined) doc.notify = { ntfy_topic_url: req.notifyUrl };
  return doc;
}

async function generateDaemonKey(keysDir: string, deps: InitDeps): Promise<GeneratedKey> {
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  await chmod(keysDir, 0o700);
  const privPath = path.join(keysDir, DAEMON_KEY_NAME);
  await assertAbsent(privPath, "a daemon signing key already exists; refusing to replace it");
  if (deps.generateKey) return deps.generateKey(keysDir);
  return sshKeygen(privPath, deps.exec);
}

/**
 * `ssh-keygen -t ed25519` with an empty passphrase: `skepd` signs without a human present
 * (PRD §11.4). The comment is informational; trust comes from `allowed_signers`, not from it.
 */
async function sshKeygen(privPath: string, exec: typeof execFileChecked): Promise<GeneratedKey> {
  try {
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "skepd", "-f", privPath], {
      env: sshEnv(),
    });
  } catch (error) {
    throw new CliError(
      "keygen_failed",
      `could not generate the daemon key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await chmod(privPath, 0o600);
  const pubPath = `${privPath}.pub`;
  const pubLine = (await readFile(pubPath, "utf8")).trim();
  if (!pubLine.startsWith("ssh-ed25519 ")) {
    throw new CliError("keygen_failed", "ssh-keygen did not write an ed25519 public key");
  }
  return { privPath, pubPath, pubLine };
}

/** The smallest environment `ssh-keygen` needs. No provider variable is forwarded (D19). */
function sshEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The controller's local trust root: the human line, then the daemon line (PRD §11.2). Both are
 * public keys. Written only when `allowed_signers` is absent, so a hand-edited trust root is
 * never replaced; the text is also returned so the human can create the file by hand.
 */
async function localTrustText(req: InitRequest, daemonKey: GeneratedKey): Promise<string | null> {
  if (req.humanKeyPath === undefined || req.humanKeyPath === "") return null;
  const humanPub = await readPublicKey(req.humanKeyPath);
  return `human namespaces="${GIT_NAMESPACE}" ${humanPub}\n${allowedSignersLine(req.device, daemonKey.pubLine)}\n`;
}

/** `ssh-keygen -y` over the human private key. The public half is what the trust root stores. */
async function readPublicKey(keyPath: string): Promise<string> {
  let text: string;
  try {
    text = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  } catch {
    throw new CliError(
      "human_key_unusable",
      `no public key next to ${keyPath}; expected ${keyPath}.pub (the private key is never copied)`,
    );
  }
  if (!/^ssh-\S+ \S+/.test(text)) {
    throw new CliError("human_key_unusable", `${keyPath}.pub is not an SSH public key`);
  }
  return text;
}

async function writeTrustRoot(file: string, text: string): Promise<void> {
  try {
    await access(file);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError("init_failed", `could not check ${file}: ${(error as Error).message}`);
    }
  }
  const handle = await open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw new CliError("init_failed", `could not write ${file}: ${error.message}`);
  });
  if (handle === null) return;
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
}

async function writeDeviceToml(file: string, document: Record<string, unknown>): Promise<void> {
  const text = `${stringifyToml(document)}\n`;
  // `wx` so a concurrent init cannot clobber a file created between the check and the write.
  const handle = await open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new CliError(
        "already_initialized",
        "device.toml already exists; refusing to overwrite it",
      );
    }
    throw new CliError("init_failed", `could not write ${file}: ${error.message}`);
  });
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
}

async function bootstrapGenesis(
  req: InitRequest,
  daemonKey: GeneratedKey,
  deps: InitDeps,
): Promise<string> {
  const humanKey = req.humanKeyPath;
  if (humanKey === undefined) {
    throw new CliError("human_key_required", "--genesis needs --human-key");
  }
  const createdAt = req.createdAt ?? isoUtc((deps.clock ?? systemClock).nowMs());
  const blackboardId = req.blackboardId ?? defaultBlackboardId(daemonKey.pubLine);
  const genesis: Genesis = {
    schema: "skep.genesis/v1",
    protocol_version: 1,
    reducer_version: REDUCER_VERSION,
    blackboard_id: blackboardId,
    created_at: createdAt,
  };
  const ident: Ident = {
    name: "human",
    email: "human@example.invalid",
    timestampSec: Math.floor(Date.parse(createdAt) / 1000),
    tz: "+0000",
  };
  if (!Number.isFinite(ident.timestampSec)) {
    throw new CliError("invalid_created_at", "--created-at must be an ISO-8601 UTC timestamp");
  }
  const git = new NodeGitRunner();
  const clone = new BlackboardClone({
    git,
    dir: req.paths.blackboardClone,
    remoteUrl: req.blackboardUrl,
  });
  const signer = new SshKeySigner({ principal: "human", keyPath: humanKey });
  const create = deps.createGenesis ?? createGenesis;
  try {
    // The policy copy is audit data only (§7.3). It lists the daemon key this init just minted
    // so the controller can see which device bootstrapped the log; trust stays local.
    return await create({
      git,
      clone,
      signer,
      genesis,
      allowedSignersText: `${allowedSignersLine(req.device, daemonKey.pubLine)}\n`,
      ident,
    });
  } catch (error) {
    if (error instanceof SshSigningError) {
      throw new CliError("human_key_unusable", error.message);
    }
    throw new CliError("genesis_failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * A stable, non-secret id derived from the daemon public key, so two devices bootstrapping two
 * blackboards do not collide and a re-run of the same key proposes the same id. The human can
 * always override it with `--blackboard-id`.
 */
function defaultBlackboardId(pubLine: string): string {
  const key = pubLine.split(" ")[1] ?? "";
  const slug = Buffer.from(key, "base64").subarray(0, 8).toString("hex").slice(0, 12);
  return `bb_${slug.padEnd(4, "0")}`;
}

const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseRepos(specs: string[]): { name: string; url: string }[] {
  return specs.map((spec) => {
    const eq = spec.indexOf("=");
    const name = eq === -1 ? "" : spec.slice(0, eq);
    const url = eq === -1 ? "" : spec.slice(eq + 1);
    if (!REPO_NAME_RE.test(name) || url.trim() === "" || /[\0\r\n]/.test(url)) {
      throw new CliError(
        "invalid_repo",
        `--repo expects name=url with a lowercase name, got '${spec}'`,
        EXIT.usage,
      );
    }
    return { name, url };
  });
}

/** Refuse to replace a file a previous init already committed to (PRD §11.2). */
async function assertAbsent(file: string, message: string): Promise<void> {
  try {
    await access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CliError("init_failed", `could not check ${file}: ${(error as Error).message}`);
  }
  throw new CliError("already_initialized", message);
}

function requirePaths(ctx: CliContext): InitPaths {
  if (!ctx.paths) throw new CliError("no_home", "SKEP_HOME was not resolved");
  return ctx.paths;
}

function renderHuman(result: InitResult): string {
  const lines = [
    `initialized device ${result.device}`,
    `device.toml: ${result.device_toml}`,
    `daemon key: ${result.signing_key}`,
    "",
    "Add this line to the controller's allowed_signers (the private key stays on this device):",
    result.allowed_signers_line,
    "",
  ];
  if (result.allowed_signers !== null) {
    lines.push(
      "Local allowed_signers (written when the file was absent; create it by hand otherwise):",
      result.allowed_signers.trimEnd(),
      "",
    );
  }
  if (result.genesis_sha !== null) {
    lines.push(`blackboard genesis: ${result.genesis_sha}`, "");
  }
  return `${lines.join("\n")}\n`;
}
