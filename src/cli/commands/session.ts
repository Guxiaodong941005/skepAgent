/**
 * `skep session` — the CLI surface of session mode (in-memory master/sub channel on one TCP port).
 *
 * The protocol engine lives in `src/session/`. Commands reach it through the {@link SessionApi}
 * subset declared below, so tests can inject `sessionApi` on the context instead.
 *
 * A joined sub works its items here: it checks out a session branch, runs the agent (or commits a
 * marker on the dry path), runs one trusted check, and submits by this device's own policy. The
 * master only learns the outcome; `skep session submit` finishes a deferred submit locally.
 *
 * `intent` and `status` talk to a running master over the plaintext control frame, authenticated
 * by the token in `${SKEP_HOME}/session.json`. The master writes that file after it binds and
 * removes it on clean exit.
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { type Command, Option } from "commander";
import { z } from "zod";
import { loadAgentMd } from "../../config/agent-md.js";
import { ConfigError, parseTomlConfig } from "../../config/errors.js";
import { type AgentCliSchema, RepoRefSchema, ShaSchema } from "../../core/schemas/common.js";
import { CHECKS_FILE_PATH, ChecksFileSchema } from "../../core/schemas/config.js";
import { Redactor } from "../../exec/redact.js";
import { type Notification, NtfyNotifier } from "../../notify/ntfy.js";
import type { ProcessExit } from "../../runtime/types.js";
import {
  connectSub,
  type DatalistEntry,
  type MasterHandle,
  type MasterOptions,
  type PlanItem,
  type SubHandle,
  type SubmitMethod,
  type SubmitOutcome,
  SubmitOutcomeSchema,
  type SubOptions,
  type SubResult,
  startMaster,
} from "../../session/index.js";
import { type Clock, isoUtc, systemClock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import { atomicWrite, safeJoin } from "../../util/fs.js";
import { cryptoRandom } from "../../util/random.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";

export const DEFAULT_PORT = 7419;
const SESSION_FILE = "session.json";
/** A stale `session.json` must not hang `start`; a live master answers well within this. */
const PROBE_TIMEOUT_MS = 2_000;
const CONTROL_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 65_536;
const MAX_INTENT_TEXT = 4_000;
const MAX_INTENT_REPOS = 16;
const MAX_DATALIST_PATH = 1_024;

const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
/** Interfaces that are never what a peer on the LAN should dial. */
const SKIPPED_IFACE_RE = /^(lo|docker|br-|veth|tun|tap|utun|tailscale|wg|virbr)/;

export interface HostPort {
  host: string;
  port: number;
}

export interface SessionApi {
  startMaster(options: MasterOptions): Promise<MasterHandle>;
  connectSub(options: SubOptions): Promise<SubHandle>;
}

export type { DatalistEntry, MasterHandle, MasterOptions, PlanItem, SubHandle, SubOptions };

export type SessionCliContext = CliContext & {
  sessionApi?: SessionApi;
  stdin?: Readable;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Directory inside the device's repo (default: `process.cwd()`). Tests point it at a temp repo. */
  cwd?: string;
  /** The SK-620 PTY runner and herdr client (default: {@link loadAgentRuntime}). Tests inject fakes. */
  agentRuntime?: () => Promise<AgentRuntime>;
  /** Tells the human something needs them (default: ntfy from `device.toml`, if configured). */
  notify?: (notification: Notification) => Promise<unknown>;
};

// ---------------------------------------------------------------------------------------------
// Wire schemas, duplicated from the shared contract so this file does not import src/session.

const ControlErrorCodeSchema = z.enum(["bad_token", "bad_request", "no_match", "not_local"]);

const ControlResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("control-result"),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("control-result"),
    ok: z.literal(false),
    error: z.strictObject({ code: ControlErrorCodeSchema, message: z.string() }),
  }),
]);
export type ControlResult = z.infer<typeof ControlResultSchema>;

const PlanItemSchema = z.strictObject({
  itemId: z.string().regex(/^I-\d+$/),
  repo: RepoRefSchema,
  assignee: z.string().min(1),
  epoch: z.number().int().min(1),
  title: z.string().max(200),
  datalistEntries: z.number().int().min(0),
});

const ItemResultSchema = z.strictObject({
  itemId: z.string().regex(/^I-\d+$/),
  epoch: z.number().int().min(1),
  repo: RepoRefSchema,
  baseSha: ShaSchema,
  headSha: ShaSchema,
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        status: z.enum(["pass", "fail", "skip"]),
      }),
    )
    .max(64),
  summary: z.string().max(4000),
  submit: SubmitOutcomeSchema.optional(),
});

export const SessionStatusSchema = z.strictObject({
  sessionId: z.string().min(1),
  listen: z.string().min(1),
  repo: RepoRefSchema,
  joinCode: z.string().nullable(),
  joinCodeExpiresAtMs: z.number().nullable(),
  peers: z.array(
    z.strictObject({
      peerId: z.string().min(1),
      device: z.string().min(1),
      address: z.string(),
      family: z.enum(["IPv4", "IPv6"]),
      repo: z.string().nullable(),
      head: z.string().nullable(),
      role: z.string().nullable(),
    }),
  ),
  intents: z.array(
    z.strictObject({
      intentId: z.string().min(1),
      text: z.string(),
      state: z.enum(["open", "no_match", "planned"]),
      items: z.array(
        PlanItemSchema.extend({
          state: z.string().min(1),
          result: ItemResultSchema.optional(),
        }),
      ),
    }),
  ),
});
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

const IntentResultSchema = z.strictObject({ intentId: z.string().min(1) });

const SessionFileSchema = z.strictObject({
  listen: z.string().min(1),
  token: z.string().regex(TOKEN_RE),
});
type SessionFile = z.infer<typeof SessionFileSchema>;

// ---------------------------------------------------------------------------------------------
// Frame codec: uint32 BE length (1..65536) + payload.

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.length < 1 || payload.length > MAX_FRAME_BYTES) {
    throw new FrameError(
      `frame payload must be 1..${MAX_FRAME_BYTES} bytes, got ${payload.length}`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder. A bad length throws: the caller must destroy the connection. */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: Buffer[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) {
        throw new FrameError(`frame length ${length} is outside 1..${MAX_FRAME_BYTES}`);
      }
      if (this.buffered.length < 4 + length) break;
      frames.push(this.buffered.subarray(4, 4 + length));
      this.buffered = this.buffered.subarray(4 + length);
    }
    return frames;
  }
}

// ---------------------------------------------------------------------------------------------
// Control client.

export class ControlConnectionError extends Error {
  constructor(target: string, reason: string, options?: ErrorOptions) {
    super(`session master at ${target}: ${reason}`, options);
    this.name = "ControlConnectionError";
  }
}

/** One control request, one reply, close (shared contract "Control"). */
export function controlRequest(
  target: HostPort,
  request: Record<string, unknown>,
  clock: Clock,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
): Promise<ControlResult> {
  const label = formatHostPort(target);
  return new Promise((resolve, reject) => {
    const timer = new AbortController();
    const decoder = new FrameDecoder();
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    const finish = (error: Error | null, reply?: ControlResult): void => {
      if (settled) return;
      settled = true;
      timer.abort();
      socket.destroy();
      if (error !== null) reject(error);
      else if (reply !== undefined) resolve(reply);
    };
    clock.sleep(timeoutMs, timer.signal).then(
      () => finish(new ControlConnectionError(label, `no reply within ${timeoutMs} ms`)),
      // Aborted because the exchange finished first.
      () => undefined,
    );
    socket.on("connect", () => {
      socket.write(encodeFrame(Buffer.from(JSON.stringify(request), "utf8")));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        const [frame] = decoder.push(chunk);
        if (frame === undefined) return;
        const parsed = ControlResultSchema.safeParse(JSON.parse(frame.toString("utf8")));
        if (!parsed.success) {
          finish(new ControlConnectionError(label, "malformed control-result"));
          return;
        }
        finish(null, parsed.data);
      } catch (error) {
        finish(new ControlConnectionError(label, errorMessage(error), { cause: error }));
      }
    });
    socket.on("error", (error) => {
      finish(new ControlConnectionError(label, error.message, { cause: error }));
    });
    socket.on("close", () => {
      finish(new ControlConnectionError(label, "connection closed before a reply"));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers.

/** `host:port`, bracketing IPv6 literals. */
export function formatHostPort(target: HostPort): string {
  return target.host.includes(":")
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

/** Parses `host:port` or `[v6]:port`. Returns null for anything else. */
export function parseHostPort(value: string): HostPort | null {
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]:");
    if (close < 0) return null;
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
    if (host.includes(":")) return null;
  }
  if (host === "" || !/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return null;
  return { host, port };
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || /^[0:]+$/.test(host);
}

/**
 * The first non-internal IPv4 address on a real LAN interface. Virtual bridges and VPN tunnels
 * are skipped: a peer on the LAN cannot reach them, and binding a wildcard is not allowed.
 */
export function pickListenHost(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
  for (const [name, infos] of Object.entries(ifaces)) {
    if (SKIPPED_IFACE_RE.test(name) || infos === undefined) continue;
    for (const info of infos) {
      // Older Node typings report `family` as the number 4.
      const family: unknown = info.family;
      if (!info.internal && (family === "IPv4" || family === 4)) return info.address;
    }
  }
  throw new CliError(
    "no_interface",
    "no LAN IPv4 interface found; pass --listen <host:port> explicitly",
    EXIT.error,
  );
}

/** Strips spaces and dashes; the result must be exactly 12 digits. */
export function normalizeJoinCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "");
  return /^\d{12}$/.test(code) ? code : null;
}

/** `NNNN-NNNN-NNNN` for display. Anything unexpected is shown as given. */
export function formatJoinCode(code: string): string {
  const normalized = normalizeJoinCode(code);
  if (normalized === null) return code;
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8)}`;
}

/**
 * If `--startwithmaster` is present and no `session` word is, the flag becomes `session start`
 * in place, so `skep --startwithmaster --yes` is `skep session start --yes`.
 */
export function expandStartWithMaster(argv: string[]): string[] {
  const index = argv.indexOf("--startwithmaster");
  if (index < 0 || argv.includes("session")) return argv;
  return [...argv.slice(0, index), "session", "start", ...argv.slice(index + 1)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionFilePath(ctx: CliContext): string {
  if (ctx.paths === undefined) throw new Error("skep home is not resolved");
  return path.join(ctx.paths.home, SESSION_FILE);
}

/** The control file, or null when absent. A file that does not parse is an error. */
async function readSessionFile(file: string): Promise<SessionFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new CliError("bad_session_file", `${file} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = SessionFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError("bad_session_file", `${file} is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function loadSessionApi(ctx: SessionCliContext): Promise<SessionApi> {
  if (ctx.sessionApi !== undefined) return ctx.sessionApi;
  return { startMaster, connectSub };
}

/** Only the named variables of `ctx.env`: `execFileChecked` never inherits the environment. */
function pickEnv(ctx: CliContext, keys: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = ctx.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Git with only the variables it needs, run in the device's repo unless `cwd` says otherwise. */
async function git(ctx: SessionCliContext, args: string[], cwd?: string): Promise<string> {
  const env = pickEnv(ctx, ["PATH", "HOME"]);
  return (await execFileChecked("git", args, { env, cwd: cwd ?? ctx.cwd })).stdout;
}

async function defaultRepo(ctx: SessionCliContext): Promise<string> {
  let top: string;
  try {
    top = (await git(ctx, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    throw new CliError(
      "repo_required",
      `not inside a git repository; pass --repo <name> (${errorMessage(error)})`,
      EXIT.usage,
    );
  }
  return path.basename(top);
}

function validRepo(repo: string): string {
  if (!RepoRefSchema.safeParse(repo).success) {
    throw new CliError("bad_repo", `invalid repo name: ${JSON.stringify(repo)}`, EXIT.usage);
  }
  return repo;
}

/** A device name from the hostname, coerced into `^[a-z0-9][a-z0-9-]{0,62}$`. */
function defaultDevice(): string {
  const name = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return DEVICE_RE.test(name) ? name : "device";
}

function validDevice(device: string | undefined): string {
  const value = device ?? defaultDevice();
  if (!DEVICE_RE.test(value)) {
    throw new CliError("bad_device", `invalid device name: ${JSON.stringify(value)}`, EXIT.usage);
  }
  return value;
}

function expiryText(expiresAtMs: number | null): string {
  return expiresAtMs === null ? "" : ` (expires ${isoUtc(expiresAtMs)})`;
}

/** The address the master actually bound, as `host:port` for `session.json`. */
function listenOf(handle: MasterHandle): string {
  if (handle.address === null) {
    throw new CliError("no_listen", "session master did not bind an address");
  }
  return formatHostPort(handle.address);
}

/**
 * Line reader shared by every join prompt: one readline interface for the whole run, so an
 * answer typed ahead is not lost between prompts. EOF answers "no".
 */
class LineReader {
  private readonly rl: Interface;
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  private ended = false;

  constructor(input: Readable) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  next(): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  pause(): void {
    this.rl.pause();
  }

  resume(): void {
    this.rl.resume();
  }

  close(): void {
    this.rl.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Sub-side item work: materialize, execute, check, submit.
//
// A sub and the master do not share a repo, so what happens to a finished item's code is decided
// here, by this device's own policy or the human at it. The master only records the outcome.

const SUBMIT_METHODS = ["pr", "mr", "push", "none", "ask"] as const;
const SUBMIT_COMMAND_METHODS = ["pr", "mr", "push", "none", "skip"] as const;
const DIRECT_METHODS = ["pr", "mr", "push", "none"] as const;
type DirectMethod = (typeof DIRECT_METHODS)[number];

const AGENT_TIMEOUT_MS = 10 * 60_000;
const MARKER_FILE = ".skep-session-item";
const MAX_SUMMARY = 4_000;
/** Stands in for a base sha when git could not even read `HEAD`: the result must still parse. */
const UNKNOWN_SHA = "0".repeat(40);
/** Variables the agent may see. Credentials are never forwarded to it (D19). */
const AGENT_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
/** `git push` uses this device's own transport setup; nothing here crosses to the master. */
const PUSH_ENV_KEYS = ["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "XDG_CONFIG_HOME"];
const HOST_ENV_KEYS = [
  ...PUSH_ENV_KEYS,
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GITLAB_TOKEN",
  "GITLAB_HOST",
];

/**
 * The `submit` key of this device's `device.toml`. Parsed locally and loosely: every other key
 * of the file is ignored, so this tolerates the device schema with or without `submit`.
 */
const SubmitPolicySchema = z
  .strictObject({
    method: z.enum(SUBMIT_METHODS).default("ask"),
    host: z.enum(["github", "gitlab", "git"]).default("github"),
  })
  .default({ method: "ask", host: "github" });
export type SubmitPolicy = z.infer<typeof SubmitPolicySchema>;
const DevicePolicyFileSchema = z.object({ submit: SubmitPolicySchema });

const DEFAULT_POLICY: SubmitPolicy = { method: "ask", host: "github" };

/**
 * Submit policy from `device.toml`. A missing file, a missing key, or a file that does not parse
 * all mean `ask`: the human decides. A plain git host has no PR/MR concept, so it forces `push`.
 */
export async function loadSubmitPolicy(
  file: string,
  warn: (message: string) => void = () => {},
): Promise<SubmitPolicy> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
  let policy: SubmitPolicy;
  try {
    policy = parseTomlConfig(DevicePolicyFileSchema, text, file).submit;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    warn(`ignoring submit policy (${error.message}); falling back to ask`);
    return DEFAULT_POLICY;
  }
  return policy.host === "git" ? { ...policy, method: "push" } : policy;
}

export function sessionBranch(itemId: string, epoch: number): string {
  return `skep/session/${itemId}-e${epoch}`;
}

export class SessionItemError extends Error {
  constructor(stage: string, message: string, options?: ErrorOptions) {
    super(`${stage}: ${message}`, options);
    this.name = "SessionItemError";
  }
}

async function onPath(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    try {
      await access(path.join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      // Not in this PATH entry; keep looking.
    }
  }
  return false;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface Materialized {
  dir: string;
  branch: string;
  baseSha: string;
}

/**
 * A fresh checkout of this device's `HEAD` on the item's session branch. A linked worktree keeps
 * the branch in the device's repo; when `git worktree` is unavailable a local clone is used and
 * the branch is fetched back after the commit (see {@link syncBack}).
 */
export async function materializeItem(
  ctx: SessionCliContext,
  item: PlanItem,
  root: string,
  opts: { worktree?: boolean } = {},
): Promise<Materialized & { clone: string | null }> {
  const top = (await git(ctx, ["rev-parse", "--show-toplevel"])).trim();
  const baseSha = (await git(ctx, ["rev-parse", "HEAD"], top)).trim();
  const branch = sessionBranch(item.itemId, item.epoch);
  const dir = path.join(root, `${path.basename(top)}-${item.itemId}-e${item.epoch}`);
  // Item ids restart in every session; an earlier session's unsubmitted work is never clobbered.
  const existing = await git(ctx, ["branch", "--list", branch], top);
  if (existing.trim() !== "" || (await exists(dir))) {
    throw new SessionItemError(
      "materialize",
      `${branch} or ${dir} already exists; submit or delete it first`,
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (opts.worktree !== false) {
    try {
      await git(ctx, ["worktree", "add", "--quiet", "-b", branch, dir, baseSha], top);
      return { dir, branch, baseSha, clone: null };
    } catch {
      // Fall through to a plain clone below; its failure is the one reported.
      await rm(dir, { recursive: true, force: true });
    }
  }
  await git(ctx, ["clone", "--quiet", "--no-checkout", top, dir]);
  await git(ctx, ["checkout", "--quiet", "-b", branch, baseSha], dir);
  // The clone's `origin` is the device repo; pushes must go where the device repo pushes.
  const origin = await git(ctx, ["remote", "get-url", "origin"], top).catch(() => null);
  if (origin === null) await git(ctx, ["remote", "remove", "origin"], dir);
  else await git(ctx, ["remote", "set-url", "origin", origin.trim()], dir);
  return { dir, branch, baseSha, clone: top };
}

/** A clone's branch is copied into the device repo so `skep session submit` can find it later. */
async function syncBack(ctx: SessionCliContext, work: Materialized, top: string): Promise<void> {
  await git(ctx, ["fetch", "--quiet", work.dir, `${work.branch}:${work.branch}`], top);
}

/** Commit everything in the checkout. Falls back to a placeholder identity only if none is set. */
async function commitAll(ctx: SessionCliContext, dir: string, message: string): Promise<boolean> {
  await git(ctx, ["add", "-A"], dir);
  const status = await git(ctx, ["status", "--porcelain"], dir);
  if (status.trim() === "") return false;
  const configured = await git(ctx, ["config", "user.email"], dir).then(
    (value) => value.trim() !== "",
    () => false,
  );
  const identity = configured
    ? []
    : ["-c", "user.name=skep", "-c", "user.email=skep@example.invalid"];
  await git(ctx, [...identity, "commit", "--quiet", "--no-verify", "-m", message], dir);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Agent runtime: the SK-620 contract (`src/runtime/{pty,herdr,types}.ts`).
//
// The declarations below copy that contract's names and shapes. They live here, and the modules
// are loaded lazily by `loadAgentRuntime`, so this file builds and runs its dry and native paths
// before SK-620 merges; tests inject fakes through `SessionCliContext.agentRuntime`.

export type AgentCli = z.infer<typeof AgentCliSchema>;
export type AgentViewState = "working" | "idle" | "done" | "blocked" | "unknown";

export interface AgentSessionStart {
  name: string;
  kind: AgentCli;
  cwd: string;
  env: Record<string, string>;
  args?: string[];
}

export interface AgentSessionHandle {
  name: string;
  paneId: string;
  focusCommand: readonly [string, ...string[]];
}

export interface AgentSessionBackend {
  readonly name: "herdr";
  probe(): Promise<{ protocol: number; schemaVersion: number }>;
  start(opts: AgentSessionStart): Promise<AgentSessionHandle>;
  prompt(h: AgentSessionHandle, text: string): Promise<void>;
  wait(
    h: AgentSessionHandle,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AgentViewState>;
  read(h: AgentSessionHandle, opts?: { lines?: number }): Promise<string>;
  focus(h: AgentSessionHandle): Promise<void>;
  close(h: AgentSessionHandle): Promise<void>;
}

export interface PtyRunOptions {
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  transcriptPath: string;
  input: "inherit" | string;
  signal?: AbortSignal;
  clock: Clock;
  graceMs?: number;
}

export interface PtyRunResult {
  exit: ProcessExit;
  aborted: boolean;
  transcript: Buffer;
}

export interface PtyRunner {
  run(opts: PtyRunOptions): Promise<PtyRunResult>;
}

/** What a join needs from SK-620, bound together so tests replace it in one place. */
export interface AgentRuntime {
  ptyRunner(): PtyRunner;
  herdrBackend(): AgentSessionBackend;
  stripTerminalControls(text: string): string;
  /** True for SK-620's `PtyUnavailableError`: the PTY never started, so native may run. */
  isPtyUnavailable(error: unknown): boolean;
}

export class AgentRuntimeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeUnavailableError";
  }
}

interface PtyModule {
  createPtyRunner(): PtyRunner;
  stripTerminalControls(text: string): string;
  PtyUnavailableError: abstract new (...args: never[]) => Error;
}

interface HerdrModule {
  createHerdrBackend(): AgentSessionBackend;
}

/**
 * Loads `src/runtime/pty.js` and `herdr.js`. The specifiers are computed, so the compiler does not
 * resolve them; a build without the modules reports them unavailable and the item falls back.
 */
export async function loadAgentRuntime(): Promise<AgentRuntime> {
  let pty: PtyModule;
  let herdr: HerdrModule;
  try {
    [pty, herdr] = await Promise.all([
      import(new URL("../../runtime/pty.js", import.meta.url).href) as Promise<PtyModule>,
      import(new URL("../../runtime/herdr.js", import.meta.url).href) as Promise<HerdrModule>,
    ]);
  } catch (error) {
    throw new AgentRuntimeUnavailableError(
      `the PTY/herdr runtime is not in this build (${errorMessage(error)})`,
      { cause: error },
    );
  }
  return {
    ptyRunner: () => pty.createPtyRunner(),
    herdrBackend: () => herdr.createHerdrBackend(),
    stripTerminalControls: (text) => pty.stripTerminalControls(text),
    isPtyUnavailable: (error) => error instanceof pty.PtyUnavailableError,
  };
}

/**
 * SK-620's `AgentSessionError.fallbackSafe`, read structurally: true only while no prompt was
 * accepted, so a native re-run cannot duplicate work (D28, §11.4).
 */
function isFallbackSafe(error: unknown): boolean {
  return (
    error instanceof Error &&
    "fallbackSafe" in error &&
    (error as { fallbackSafe: unknown }).fallbackSafe === true
  );
}

/**
 * Drops every control character but newline and tab. Only used when the runtime module is absent
 * (the native path still has to keep terminal controls off the wire); SK-620's
 * `stripTerminalControls` also removes whole escape sequences.
 */
function dropControlChars(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0);
    if (!control || char === "\n" || char === "\t") out += char;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Join view (SK-622 hook).

export type JoinAgentState = "starting" | "running" | "blocked" | "done" | "failed";

export const AGENT_VIEWS = ["dry", "pty", "herdr", "native"] as const;
export type AgentView = (typeof AGENT_VIEWS)[number];

export interface JoinViewModel {
  peers: { peerId: string; device: string; role: string; state: string }[];
  item: { itemId: string; title: string; repo: string; epoch: number } | null;
  agent: {
    cli: AgentCli;
    view: AgentView;
    state: JoinAgentState;
    focusCommand?: readonly string[];
  } | null;
  /** Already redacted and control-stripped, at most 4000 characters. */
  tail: string;
  submit: { policy: SubmitMethod; outcome?: SubmitOutcome };
}

export interface JoinView {
  update(model: JoinViewModel): void;
  /** Replaces ItemWorker.ask when the policy is "ask"; null = defer (skip). */
  chooseSubmit(model: JoinViewModel): Promise<"pr" | "mr" | "push" | "none" | null>;
  /** PTY: give the terminal to the agent; resolves when the TUI may redraw. */
  suspend(): Promise<void>;
  resume(): void;
  close(): void;
}

export type JoinViewFactory = (io: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}) => JoinView;

let joinViewFactory: JoinViewFactory | null = null;

/** Registers the full-screen view used by `session join --ui`; null unregisters it (tests). */
export function setJoinViewFactory(factory: JoinViewFactory | null): void {
  joinViewFactory = factory;
}

// ---------------------------------------------------------------------------------------------
// Running the agent: dry marker, PTY, herdr pane, or the native non-interactive CLI (D27, D28).

/** Non-interactive argv per CLI; the prompt goes on stdin. Never an approval-bypass flag (D29). */
export const NATIVE_ARGV: Readonly<Record<AgentCli, readonly string[]>> = {
  codex: ["exec", "-"],
  claude: ["-p"],
  pi: ["-p"],
};

/** A herdr run waits for the human-paced agent far longer than a non-interactive one. */
const HERDR_WAIT_MS = 4 * 60 * 60_000;
const HERDR_READ_LINES = 200;
/** Only this much of a transcript is cleaned for the summary; the file keeps everything. */
const TAIL_WINDOW = 64 * 1024;

/**
 * `--agent` wins; otherwise `SKEP_SESSION_EXEC=1` selects pty, or herdr with
 * `SKEP_SESSION_VIEW=herdr`; otherwise the dry marker.
 */
export function selectAgentView(flag: AgentView | undefined, env: NodeJS.ProcessEnv): AgentView {
  if (flag !== undefined) return flag;
  if (env.SKEP_SESSION_EXEC !== "1") return "dry";
  return env.SKEP_SESSION_VIEW === "herdr" ? "herdr" : "pty";
}

/** How a joined device runs its agent. Absent on an {@link ItemWorker} means dry. */
export interface AgentSetup {
  view: AgentView;
  /** This device's AGENT.md `agent_cli`; the master never chooses it (D27). */
  cli: AgentCli;
  runtime(): Promise<AgentRuntime>;
  /** Local directory for raw transcripts (0600 files). Never sent anywhere. */
  journal: string;
  notify(notification: Notification): Promise<unknown>;
}

/** herdr agent names are `^[a-z0-9][a-z0-9-]{0,63}$`. */
export function herdrAgentName(item: PlanItem): string {
  return `skep-${item.itemId.toLowerCase()}-e${item.epoch}`;
}

/**
 * Summary text from a raw transcript: terminal controls stripped, then redacted, then the tail.
 * Redacting before cutting keeps a secret from being split into an unrecognisable fragment;
 * anything cut at the window's start is far outside the final tail.
 */
export function summaryTail(
  raw: string,
  strip: (text: string) => string,
  max = MAX_SUMMARY,
): string {
  const cleaned = new Redactor().redact(strip(raw.slice(-TAIL_WINDOW))).trim();
  return cleaned.slice(-max);
}

type Executed =
  | { status: "ok"; changed: boolean; summary: string }
  | { status: "failed"; summary: string }
  | { status: "blocked"; summary: string };

/** One agent run's raw outcome, before commit and cleaning. `tail` is local, unredacted text. */
interface AgentRun {
  ok: boolean;
  status: string;
  tail: string;
  blocked?: { name: string; focusCommand: readonly string[] };
}

interface RunContext {
  worker: ItemWorker;
  setup: AgentSetup;
  item: PlanItem;
  dir: string;
  prompt: string;
  env: Record<string, string>;
  transcript: string;
  report(state: JoinAgentState, focusCommand?: readonly string[]): void;
}

async function writePrivate(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, data, { mode: 0o600 });
}

async function runNative(run: RunContext): Promise<AgentRun> {
  const { setup, dir, prompt, env } = run;
  run.report("running");
  const result = await execFileChecked(setup.cli, [...NATIVE_ARGV[setup.cli]], {
    cwd: dir,
    env,
    input: prompt,
    timeoutMs: AGENT_TIMEOUT_MS,
    allowFailure: true,
  });
  const tail = `${result.stdout}\n${result.stderr}`;
  await writePrivate(run.transcript, tail);
  const status = result.timedOut ? "timed out" : `exited ${result.code ?? result.signal ?? "?"}`;
  return { ok: result.code === 0, status, tail };
}

/** The human watches and answers the agent in this terminal; it ends when they quit it. */
async function runPty(run: RunContext, runtime: AgentRuntime): Promise<AgentRun> {
  const { worker, setup, dir, prompt, env } = run;
  const view = worker.view;
  const exclusive = worker.terminal ?? ((fn) => fn());
  return exclusive(async () => {
    run.report("running");
    await view?.suspend();
    try {
      const result = await runtime.ptyRunner().run({
        argv: [setup.cli, prompt],
        cwd: dir,
        env,
        transcriptPath: run.transcript,
        input: "inherit",
        clock: systemClock,
        ...(worker.signal === undefined ? {} : { signal: worker.signal }),
      });
      const { code, signal } = result.exit;
      return {
        ok: !result.aborted && code === 0,
        status: result.aborted ? "aborted" : `exited ${code ?? signal ?? "?"}`,
        tail: result.transcript.toString("utf8"),
      };
    } finally {
      view?.resume();
    }
  });
}

/**
 * Starts the agent in a local herdr pane, prompts it once and waits. Errors before the prompt is
 * accepted keep `fallbackSafe`; the pane is closed so the native run does not leave it behind.
 */
async function runHerdr(run: RunContext, runtime: AgentRuntime): Promise<AgentRun> {
  const { setup, item, dir, prompt, env } = run;
  const backend = runtime.herdrBackend();
  await backend.probe();
  const handle = await backend.start({
    name: herdrAgentName(item),
    kind: setup.cli,
    cwd: dir,
    env,
  });
  run.report("running", handle.focusCommand);
  try {
    await backend.prompt(handle, prompt);
  } catch (error) {
    if (isFallbackSafe(error)) await backend.close(handle).catch(() => undefined);
    throw error;
  }
  const state = await backend.wait(handle, {
    timeoutMs: HERDR_WAIT_MS,
    ...(run.worker.signal === undefined ? {} : { signal: run.worker.signal }),
  });
  // The pane stays open: the human may still want to read it or, when blocked, answer it.
  const tail = await backend
    .read(handle, { lines: HERDR_READ_LINES })
    .catch((error: unknown) => `(could not read the agent's output: ${errorMessage(error)})`);
  await writePrivate(run.transcript, tail);
  if (state === "blocked") {
    return {
      ok: false,
      status: "blocked",
      tail,
      blocked: { name: handle.name, focusCommand: handle.focusCommand },
    };
  }
  const ok = state === "done" || state === "idle";
  return { ok, status: ok ? `${state}` : `stopped in state ${state}`, tail };
}

/**
 * Runs the item with the worker's strategy. Dry commits a marker so the result still carries a
 * real new head. herdr falls back to native only on a `fallbackSafe` error, PTY only when the PTY
 * could not start (D28); the reason is printed.
 */
async function executeItem(
  worker: ItemWorker,
  item: PlanItem,
  dir: string,
  report: RunContext["report"],
): Promise<Executed> {
  const { ctx } = worker;
  const message = `session ${item.itemId} epoch ${item.epoch}`;
  const setup = worker.agent;
  if (setup === undefined || setup.view === "dry") {
    await writeFile(path.join(dir, MARKER_FILE), `${item.itemId}\n`);
    await commitAll(ctx, dir, message);
    return {
      status: "ok",
      changed: true,
      summary: "dry run: committed the session marker (no agent configured)",
    };
  }

  const run: RunContext = {
    worker,
    setup,
    item,
    dir,
    // The item title is the task, exactly as the native CLI reads it on stdin.
    prompt: `${item.title}\n`,
    env: {
      ...pickEnv(ctx, AGENT_ENV_KEYS),
      SKEP_SESSION_ITEM: item.itemId,
      SKEP_SESSION_EPOCH: String(item.epoch),
    },
    transcript: path.join(
      setup.journal,
      `${item.itemId}-e${item.epoch}-${systemClock.nowMs()}-${setup.view}.log`,
    ),
    report,
  };
  // The PTY runner creates the transcript file, not its directory.
  await mkdir(setup.journal, { recursive: true, mode: 0o700 });
  let runtime: AgentRuntime | null = null;
  let unavailable = "";
  try {
    runtime = await setup.runtime();
  } catch (error) {
    unavailable = errorMessage(error);
  }

  report("starting");
  let agent: AgentRun | null = null;
  let fallback: string | null = null;
  if (setup.view === "native") {
    agent = await runNative(run);
  } else if (runtime === null) {
    fallback = `${setup.view} is unavailable: ${unavailable}`;
  } else {
    try {
      agent = setup.view === "pty" ? await runPty(run, runtime) : await runHerdr(run, runtime);
    } catch (error) {
      const safe = setup.view === "pty" ? runtime.isPtyUnavailable(error) : isFallbackSafe(error);
      if (!safe) throw error;
      fallback = `${setup.view} is unavailable: ${errorMessage(error)}`;
    }
  }
  let note = "";
  if (agent === null) {
    note = `${fallback}; ran ${setup.cli} non-interactively\n`;
    ctx.stderr.write(`skep: item ${item.itemId}: ${note}`);
    run.transcript = run.transcript.replace(/-[a-z]+\.log$/, "-native.log");
    agent = await runNative(run);
  }

  const strip = runtime?.stripTerminalControls ?? dropControlChars;
  const tail = summaryTail(agent.tail, strip);
  if (agent.blocked !== undefined) {
    const focus = agent.blocked.focusCommand.join(" ");
    const waiting = `agent ${agent.blocked.name} is waiting for you: ${focus}`;
    // Never answered for the human (D29): no keys are sent; they decide in the agent's own UI.
    ctx.stderr.write(`${waiting}\n`);
    await setup
      .notify({ title: `skep: ${item.itemId} needs you`, message: waiting, tags: ["warning"] })
      .catch(() => undefined);
    report("blocked", agent.blocked.focusCommand);
    return {
      status: "blocked",
      summary:
        `${note}${waiting}\nfinish in the pane, commit in ${dir}, ` +
        `then run skep session submit ${item.itemId} --epoch ${item.epoch}\n${tail}`,
    };
  }
  if (!agent.ok) return { status: "failed", summary: `${note}agent ${agent.status}\n${tail}` };
  const changed = await commitAll(ctx, dir, message);
  return {
    status: "ok",
    changed,
    summary: `${note}agent ${agent.status}${changed ? "" : "; no changes"}\n${tail}`,
  };
}

type CheckStatus = { name: string; status: "pass" | "fail" | "skip" };

/** One trusted check from the checkout's own `.skep/checks.toml`: `unit`, else the first. */
async function runChecks(ctx: SessionCliContext, dir: string): Promise<CheckStatus[]> {
  const file = path.join(dir, CHECKS_FILE_PATH);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return [{ name: "none", status: "skip" }];
    throw error;
  }
  let checks: z.infer<typeof ChecksFileSchema>["checks"];
  try {
    checks = parseTomlConfig(ChecksFileSchema, text, CHECKS_FILE_PATH).checks;
  } catch (error) {
    if (error instanceof ConfigError) return [{ name: "checks-file", status: "fail" }];
    throw error;
  }
  const name = "unit" in checks ? "unit" : Object.keys(checks)[0];
  const check = name === undefined ? undefined : checks[name];
  if (name === undefined || check === undefined) return [{ name: "none", status: "skip" }];
  const [file0, ...args] = check.argv;
  if (file0 === undefined) return [{ name, status: "fail" }];
  try {
    const cwd = check.cwd === undefined ? dir : await safeJoin(dir, check.cwd);
    const run = await execFileChecked(file0, args, {
      cwd,
      env: { ...pickEnv(ctx, ["PATH", "HOME"]), ...check.env },
      timeoutMs: check.timeout_sec * 1000,
      allowFailure: true,
    });
    return [{ name, status: run.code === 0 ? "pass" : "fail" }];
  } catch {
    // The check could not even start (missing binary, bad cwd): that is a failing check.
    return [{ name, status: "fail" }];
  }
}

async function defaultBranch(ctx: SessionCliContext, cwd: string): Promise<string> {
  const remoteHead = await git(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)
    .then((value) => value.trim())
    .catch(() => "");
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  return "main";
}

/** `{ method, state, url?, number?, branch }`, validated so a bad URL can never reach the wire. */
function outcome(
  method: SubmitMethod,
  state: SubmitOutcome["state"],
  branch: string,
  opened?: { url: string; number?: number },
): SubmitOutcome {
  return SubmitOutcomeSchema.parse({ method, state, branch, ...opened });
}

/** The URL a host CLI printed for the new PR/MR, if it printed a valid one. */
function openedFrom(stdout: string): { url: string; number?: number } | null {
  const urls = stdout.match(/https?:\/\/\S+/g);
  const url = urls?.[urls.length - 1];
  if (url === undefined || url.length > 512 || !z.string().url().safeParse(url).success) {
    return null;
  }
  const number = url.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1];
  return number === undefined ? { url } : { url, number: Number(number) };
}

/**
 * Pushes the session branch (never the base branch) and opens a PR/MR when asked. Every failure
 * becomes a `failed` outcome rather than an exception, so `onItem` always has a result to send.
 */
export async function submitBranch(
  ctx: SessionCliContext,
  opts: { cwd: string; branch: string; method: DirectMethod; title: string; body: string },
): Promise<{ submit: SubmitOutcome; detail: string }> {
  const { cwd, branch, method } = opts;
  if (method === "none") return { submit: outcome("none", "local", branch), detail: "" };
  const host = method === "pr" ? "gh" : method === "mr" ? "glab" : null;
  if (host !== null && !(await onPath(host, ctx.env))) {
    return {
      submit: outcome(method, "local", branch),
      detail: `${host} is not on PATH; ${branch} stays local`,
    };
  }
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  const push = await execFileChecked("git", ["push", "--quiet", "origin", refspec], {
    cwd,
    env: pickEnv(ctx, PUSH_ENV_KEYS),
    allowFailure: true,
  }).catch((error: unknown) => ({ code: null, stdout: "", stderr: errorMessage(error) }));
  if (push.code !== 0) {
    return { submit: outcome(method, "failed", branch), detail: push.stderr.trim() };
  }
  if (host === null) return { submit: outcome(method, "pushed", branch), detail: "" };
  const base = await defaultBranch(ctx, cwd);
  const args =
    host === "gh"
      ? ["pr", "create", "--head", branch, "--base", base, "--title", opts.title]
      : ["mr", "create", "--source-branch", branch, "--target-branch", base, "--title", opts.title];
  args.push(host === "gh" ? "--body" : "--description", opts.body);
  const created = await execFileChecked(host, args, {
    cwd,
    env: pickEnv(ctx, HOST_ENV_KEYS),
    allowFailure: true,
  }).catch((error: unknown) => ({ code: null, stdout: "", stderr: errorMessage(error) }));
  if (created.code !== 0) {
    return { submit: outcome(method, "failed", branch), detail: created.stderr.trim() };
  }
  const opened = openedFrom(created.stdout);
  // Created but no URL to show for it: the branch is at least pushed.
  if (opened === null) return { submit: outcome(method, "pushed", branch), detail: "" };
  return { submit: outcome(method, "opened", branch, opened), detail: "" };
}

function submitLine(submit: SubmitOutcome): string {
  return `submit ${submit.method} ${submit.state}${submit.url === undefined ? "" : ` ${submit.url}`}`;
}

export interface ItemWorker {
  ctx: SessionCliContext;
  /** Where session checkouts live (under SKEP_HOME, never inside the device repo). */
  root: string;
  method: SubmitMethod;
  /** Asks the human; null on EOF. Only used when `method` is `ask`. */
  ask(question: string): Promise<string | null>;
  /** False forces the clone fallback (tests; hosts whose git lacks `worktree`). */
  worktree?: boolean;
  /** How the agent runs; absent means the dry marker. */
  agent?: AgentSetup;
  /** Receives state changes; a PTY run is bracketed by `suspend()`/`resume()`. */
  view?: JoinView;
  /** Replaces {@link ask} when set (`--ui`): the view asks the human. */
  chooseSubmit?: JoinView["chooseSubmit"];
  /** Peers shown in the view model (this device once joined). */
  peers?: JoinViewModel["peers"];
  /** Serializes PTY runs: one agent owns the terminal at a time. */
  terminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Aborted when the join is closing; stops a running PTY or herdr wait. */
  signal?: AbortSignal;
}

/**
 * Keeps the head (status lines) and the end (the agent's last output) of an over-long summary.
 * It is cut only after redaction, so a cut can never expose part of a secret.
 */
function clipSummary(text: string): string {
  if (text.length <= MAX_SUMMARY) return text;
  const gap = "\n…\n";
  const head = 1_000;
  return `${text.slice(0, head)}${gap}${text.slice(-(MAX_SUMMARY - head - gap.length))}`;
}

/** Everything a sub does for one item. Never throws: a failure is a result with `failed`. */
export async function workItem(worker: ItemWorker, item: PlanItem): Promise<SubResult> {
  const { ctx } = worker;
  const redactor = new Redactor();
  const branch = sessionBranch(item.itemId, item.epoch);
  // Every summary byte that leaves for the master is control-stripped and redacted (D27).
  const clean = (text: string): string => redactor.redact(dropControlChars(text));

  let agentState: JoinAgentState = "starting";
  let focusCommand: readonly string[] | undefined;
  let tail = "";
  const show = (submit?: SubmitOutcome): JoinViewModel => ({
    peers: worker.peers ?? [],
    item: { itemId: item.itemId, title: item.title, repo: item.repo, epoch: item.epoch },
    agent:
      worker.agent === undefined
        ? null
        : {
            cli: worker.agent.cli,
            view: worker.agent.view,
            state: agentState,
            ...(focusCommand === undefined ? {} : { focusCommand }),
          },
    tail,
    submit: { policy: worker.method, ...(submit === undefined ? {} : { outcome: submit }) },
  });
  const report = (state: JoinAgentState, focus?: readonly string[]): void => {
    agentState = state;
    if (focus !== undefined) focusCommand = focus;
    worker.view?.update(show());
  };
  const result = (
    fields: Omit<SubResult, "repo" | "summary" | "submit"> & { submit: SubmitOutcome },
    summary: string,
  ): SubResult => {
    const final: SubResult = {
      repo: item.repo,
      ...fields,
      summary: clipSummary(`${submitLine(fields.submit)}\n${clean(summary)}`),
    };
    worker.view?.update(show(fields.submit));
    return final;
  };

  let work: Materialized & { clone: string | null };
  try {
    work = await materializeItem(ctx, item, worker.root, { worktree: worker.worktree });
  } catch (error) {
    const baseSha = await git(ctx, ["rev-parse", "HEAD"])
      .then((value) => value.trim())
      .catch(() => UNKNOWN_SHA);
    const sha = ShaSchema.safeParse(baseSha).success ? baseSha : UNKNOWN_SHA;
    agentState = "failed";
    return result(
      {
        baseSha: sha,
        headSha: sha,
        checks: [{ name: "git", status: "fail" }],
        submit: outcome(worker.method, "failed", branch),
      },
      errorMessage(error),
    );
  }

  const { dir, baseSha } = work;
  const headOf = () =>
    git(ctx, ["rev-parse", "HEAD"], dir)
      .then((value) => value.trim())
      .catch(() => baseSha);
  let executed: Executed;
  try {
    executed = await executeItem(worker, item, dir, report);
    if (work.clone !== null && executed.status === "ok") await syncBack(ctx, work, work.clone);
  } catch (error) {
    // After an accepted prompt a herdr failure is final: never replayed natively (§11.4).
    executed = { status: "failed", summary: errorMessage(error) };
  }
  tail = clean(executed.summary).slice(-MAX_SUMMARY);
  const headSha = await headOf();
  if (executed.status === "blocked") {
    // Nothing is committed, checked or submitted; `skep session submit` finishes it later (D29).
    agentState = "blocked";
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "agent", status: "skip" }],
        submit: outcome(worker.method, "pending", branch),
      },
      executed.summary,
    );
  }
  if (executed.status === "failed") {
    agentState = "failed";
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "agent", status: "fail" }],
        submit: outcome(worker.method, "failed", branch),
      },
      executed.summary,
    );
  }
  agentState = "done";
  if (!executed.changed) {
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "none", status: "skip" }],
        submit: outcome(worker.method, "skipped", branch),
      },
      `no changes; nothing submitted\n${executed.summary}`,
    );
  }

  const checks = await runChecks(ctx, dir).catch((): CheckStatus[] => [
    { name: "checks-file", status: "fail" },
  ]);
  if (checks.some((check) => check.status === "fail")) {
    // Failing code is never submitted; the human can fix it and run `skep session submit`.
    return result(
      { baseSha, headSha, checks, submit: outcome(worker.method, "skipped", branch) },
      `checks failed; ${branch} not submitted\n${executed.summary}`,
    );
  }

  let method: DirectMethod;
  if (worker.method === "ask") {
    let chosen: DirectMethod | undefined;
    if (worker.chooseSubmit !== undefined) {
      const picked = await worker.chooseSubmit(show());
      chosen = DIRECT_METHODS.find((value) => value === picked);
    } else {
      ctx.stderr.write(`item ${item.itemId} finished on ${branch} at ${headSha}\n`);
      const answer = (await worker.ask("Submit this item? [pr/mr/push/none/skip] "))?.trim() ?? "";
      chosen = DIRECT_METHODS.find((value) => value === answer.toLowerCase());
    }
    if (chosen === undefined) {
      return result(
        { baseSha, headSha, checks, submit: outcome("ask", "skipped", branch) },
        executed.summary,
      );
    }
    method = chosen;
  } else {
    method = worker.method;
  }
  const submitted = await submitBranch(ctx, {
    cwd: dir,
    branch,
    method,
    title: item.title === "" ? `session ${item.itemId}` : item.title,
    body: clean(executed.summary),
  }).catch((error: unknown) => ({
    submit: outcome(method, "failed", branch),
    detail: errorMessage(error),
  }));
  const detail = submitted.detail === "" ? "" : `${submitted.detail}\n`;
  return result({ baseSha, headSha, checks, submit: submitted.submit }, detail + executed.summary);
}

// ---------------------------------------------------------------------------------------------
// Commands.

interface StartOptions {
  listen?: string;
  device?: string;
  repo?: string;
  yes?: boolean;
}

interface JoinOptions {
  code: string;
  host?: string;
  device?: string;
  repo?: string;
  role: string;
  submit?: SubmitMethod;
  agent?: AgentView;
  roleDir?: string;
  ui?: boolean;
}

interface SubmitOptions {
  method: (typeof SUBMIT_COMMAND_METHODS)[number];
  epoch: string;
}

export function register(program: Command, ctx: CliContext): void {
  const sctx = ctx as SessionCliContext;
  // Rewritten to `session start` by `expandStartWithMaster`; declared only so a stray use next
  // to an explicit `session` is not an unknown-option error.
  program.addOption(new Option("--startwithmaster").hideHelp());

  const session = program
    .command("session")
    .description("Run or join an in-memory session channel between devices");

  session
    .command("start")
    .description("Start a session master and print the join code")
    .option("--listen <host:port>", `address to bind (default: LAN IPv4, port ${DEFAULT_PORT})`)
    .option("--device <name>", "this device's name (default: hostname)")
    .option("--repo <name>", "the master's repo (default: basename of the git toplevel)")
    .option("--yes", "accept every join without prompting")
    .action(async (opts: StartOptions) => {
      await startCommand(sctx, opts);
    });

  session
    .command("join")
    .description("Join a session master with its join code")
    .requiredOption("--code <code>", "the 12-digit join code shown by the master")
    .option("--host <host:port>", "master address (default: listen from local session.json)")
    .option("--device <name>", "this device's name (default: hostname)")
    .option("--repo <name>", "this device's repo (default: basename of the git toplevel)")
    .option("--role <role>", "role advertised to the master", "coding")
    .addOption(
      new Option(
        "--submit <method>",
        "how finished items are submitted (default: device policy)",
      ).choices(SUBMIT_METHODS),
    )
    .addOption(
      new Option(
        "--agent <view>",
        "how items run: dry, pty, herdr or native (default: SKEP_SESSION_EXEC/SKEP_SESSION_VIEW)",
      ).choices(AGENT_VIEWS),
    )
    .option("--role-dir <dir>", "directory holding this device's AGENT.md (default: cwd)")
    .option("--ui", "use the full-screen view")
    .action(async (opts: JoinOptions) => {
      await joinCommand(sctx, opts);
    });

  session
    .command("submit")
    .description("Submit a finished session item's local branch after a join asked or deferred")
    .argument("<itemId>", "the item id, e.g. I-1")
    .addOption(
      new Option("--method <method>", "pr, mr, push, none or skip")
        .choices(SUBMIT_COMMAND_METHODS)
        .makeOptionMandatory(),
    )
    .option("--epoch <n>", "the item's epoch", "1")
    .action(async (itemId: string, opts: SubmitOptions) => {
      await submitCommand(sctx, itemId, opts);
    });

  session
    .command("intent")
    .description("Send an intent to the running session master")
    .argument("<text>", "what should be done")
    .option("--repo <name...>", "repos to involve (default: the master's repo)")
    .action(async (text: string, opts: { repo?: string[] }) => {
      await intentCommand(sctx, text, opts.repo);
    });

  session
    .command("status")
    .description("Show peers, the join code, and intents of the running session master")
    .action(async () => {
      await statusCommand(sctx);
    });
}

async function startCommand(ctx: SessionCliContext, opts: StartOptions): Promise<void> {
  let target: HostPort;
  if (opts.listen !== undefined) {
    const parsed = parseHostPort(opts.listen);
    if (parsed === null) {
      throw new CliError(
        "bad_listen",
        `--listen must be host:port, got ${opts.listen}`,
        EXIT.usage,
      );
    }
    // A wildcard bind would expose the join handshake and control port on every interface.
    if (isWildcard(parsed.host)) {
      throw new CliError(
        "bad_listen",
        "--listen must name one interface address, not a wildcard",
        EXIT.usage,
      );
    }
    target = parsed;
  } else {
    const ifaces = (ctx.networkInterfaces ?? os.networkInterfaces)();
    target = { host: pickListenHost(ifaces), port: DEFAULT_PORT };
  }
  const device = validDevice(opts.device);
  const repo = validRepo(opts.repo ?? (await defaultRepo(ctx)));

  const file = sessionFilePath(ctx);
  await refuseIfRunning(file);

  const api = await loadSessionApi(ctx);
  const token = Buffer.from(cryptoRandom.bytes(16)).toString("hex");
  const output = ctx.output();

  let started = false;
  let code: string | null = null;
  let codeExpiresAtMs: number | null = null;
  const onJoinCode = (info: { code: string; expiresAtMs: number }): void => {
    code = formatJoinCode(info.code);
    codeExpiresAtMs = info.expiresAtMs;
    // The initial code may arrive before startMaster resolves; it is printed with the banner.
    if (!started) return;
    output.result(
      { event: "join-code", joinCode: code, joinCodeExpiresAtMs: codeExpiresAtMs },
      () => `join code: ${code ?? "none"}${expiryText(codeExpiresAtMs)}\n`,
    );
  };

  let reader: LineReader | undefined;
  let prompts: Promise<unknown> = Promise.resolve();
  const acceptJoin = (request: Parameters<MasterOptions["acceptJoin"]>[0]): Promise<boolean> => {
    if (opts.yes === true) return Promise.resolve(true);
    // One prompt at a time: concurrent joins must not interleave questions and answers.
    const answer = prompts.then(async () => {
      reader ??= new LineReader(ctx.stdin ?? process.stdin);
      const { device: who, address, fingerprint } = request;
      ctx.stderr.write(`Accept ${who} from ${address} fingerprint ${fingerprint}? [y/N] `);
      const line = await reader.next();
      return line !== null && /^\s*y(es)?\s*$/i.test(line);
    });
    prompts = answer.catch(() => undefined);
    return answer;
  };

  const handle = await api.startMaster({
    listen: target,
    repo,
    device,
    controlToken: token,
    clock: systemClock,
    random: cryptoRandom,
    onJoinCode,
    acceptJoin,
  });
  const listen = listenOf(handle);

  const stop = (): void => {
    void handle.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, `${JSON.stringify({ listen, token })}\n`, {
      mode: 0o600,
    });
    started = true;
    output.result(
      {
        event: "started",
        listen,
        repo,
        device,
        joinCode: code,
        joinCodeExpiresAtMs: codeExpiresAtMs,
      },
      () =>
        `session master listening on ${listen} (repo ${repo})\n` +
        `join code: ${code ?? "none"}${expiryText(codeExpiresAtMs)}\n`,
    );
    await handle.closed;
    output.result({ event: "closed" }, () => "session closed\n");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    reader?.close();
    await removeOwnSessionFile(file, token);
  }
}

/** A `session.json` whose master still answers `status` means a second master must not start. */
async function refuseIfRunning(file: string): Promise<void> {
  let existing: SessionFile | null;
  try {
    existing = await readSessionFile(file);
  } catch (error) {
    // A corrupt file cannot point at a live master; it is overwritten below.
    if (error instanceof CliError && error.code === "bad_session_file") return;
    throw error;
  }
  if (existing === null) return;
  const target = parseHostPort(existing.listen);
  if (target === null) return;
  try {
    await controlRequest(
      target,
      { type: "control", v: 1, token: existing.token, op: "status" },
      systemClock,
      PROBE_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ControlConnectionError) return;
    throw error;
  }
  throw new CliError(
    "session_running",
    `a session master is already running at ${existing.listen} (${file})`,
  );
}

/** Remove the control file only if it is still ours. */
async function removeOwnSessionFile(file: string, token: string): Promise<void> {
  const current = await readSessionFile(file).catch(() => null);
  if (current?.token === token) await rm(file, { force: true });
}

async function joinCommand(ctx: SessionCliContext, opts: JoinOptions): Promise<void> {
  const code = normalizeJoinCode(opts.code);
  if (code === null) {
    throw new CliError("bad_code", "--code must be 12 digits (NNNN-NNNN-NNNN)", EXIT.usage);
  }
  let target: HostPort;
  if (opts.host !== undefined) {
    const parsed = parseHostPort(opts.host);
    if (parsed === null) {
      throw new CliError("bad_host", `--host must be host:port, got ${opts.host}`, EXIT.usage);
    }
    target = parsed;
  } else {
    const local = await readSessionFile(sessionFilePath(ctx));
    const parsed = local === null ? null : parseHostPort(local.listen);
    if (parsed === null) {
      throw new CliError(
        "host_required",
        "no local session master; pass --host <host:port>",
        EXIT.usage,
      );
    }
    target = parsed;
  }
  if (!ROLE_RE.test(opts.role)) {
    throw new CliError("bad_role", `invalid role: ${JSON.stringify(opts.role)}`, EXIT.usage);
  }
  const device = validDevice(opts.device);
  const repo = validRepo(opts.repo ?? (await defaultRepo(ctx)));
  const role = opts.role;
  if (ctx.paths === undefined) throw new Error("skep home is not resolved");
  const paths = ctx.paths;
  const ui = opts.ui === true;
  if (ui && joinViewFactory === null) {
    throw new CliError("ui_unavailable", "the full-screen view is not available in this build");
  }
  const warn = (message: string): void => ctx.stderr.write(`skep: ${message}\n`);
  const view = selectAgentView(opts.agent, ctx.env);
  let agent: AgentSetup | undefined;
  if (view !== "dry") {
    agent = {
      view,
      cli: await agentCliOf(path.resolve(ctx.cwd ?? process.cwd(), opts.roleDir ?? "."), view),
      runtime: ctx.agentRuntime ?? loadAgentRuntime,
      journal: path.join(paths.home, "session", "transcripts"),
      notify: ctx.notify ?? (await deviceNotifier(paths.deviceToml, warn)),
    };
  }
  const api = await loadSessionApi(ctx);
  const output = ctx.output();
  // The full-screen view owns the terminal; event lines then go only to `--machine` output.
  const say = (data: unknown, human: () => string): void =>
    output.result(data, ui ? () => "" : human);
  // A human override on the command line wins over this device's file policy.
  const method = opts.submit ?? (await loadSubmitPolicy(paths.deviceToml, warn)).method;

  let reader: LineReader | undefined;
  let prompts: Promise<unknown> = Promise.resolve();
  const ask = (question: string): Promise<string | null> => {
    // One prompt at a time: concurrent items must not interleave questions and answers.
    const answer = prompts.then(async () => {
      reader ??= new LineReader(ctx.stdin ?? process.stdin);
      ctx.stderr.write(question);
      return reader.next();
    });
    prompts = answer.catch(() => undefined);
    return answer;
  };
  const joinView: JoinView =
    ui && joinViewFactory !== null
      ? joinViewFactory({
          stdin: (ctx.stdin ?? process.stdin) as NodeJS.ReadStream,
          stdout: process.stdout,
        })
      : new LineJoinView(ctx.stderr, ask, {
          pause: () => reader?.pause(),
          resume: () => reader?.resume(),
        });
  let terminalQueue: Promise<unknown> = Promise.resolve();
  const abort = new AbortController();
  const worker: ItemWorker = {
    ctx,
    root: path.join(paths.home, "session", "worktrees"),
    method,
    ask,
    ...(agent === undefined ? {} : { agent }),
    view: joinView,
    ...(ui ? { chooseSubmit: (model: JoinViewModel) => joinView.chooseSubmit(model) } : {}),
    peers: [],
    terminal: (fn) => {
      const run = terminalQueue.then(fn);
      terminalQueue = run.catch(() => undefined);
      return run;
    },
    signal: abort.signal,
  };

  let fingerprintShown = false;
  const showFingerprint = (fingerprint: string): void => {
    if (fingerprintShown) return;
    fingerprintShown = true;
    say(
      { event: "fingerprint", fingerprint },
      () => `fingerprint ${fingerprint} — check that the master shows the same\n`,
    );
  };

  let handle: SubHandle;
  try {
    handle = await api.connectSub({
      target,
      code,
      device,
      clock: systemClock,
      random: cryptoRandom,
      onFingerprint: showFingerprint,
      describe: async () => ({
        repo,
        role,
        head: (await git(ctx, ["rev-parse", "HEAD"])).trim(),
      }),
      collectDatalist: async () => {
        const listed = await git(ctx, ["ls-files", "-z"]);
        return listed
          .split("\0")
          .filter((file) => file.length > 0 && file.length <= MAX_DATALIST_PATH)
          .map((file) => ({ kind: "path" as const, path: file }));
      },
      onItem: async (item) => {
        say(
          { event: "item", item },
          () => `item ${item.itemId} (epoch ${item.epoch}, ${item.repo}): ${item.title}\n`,
        );
        const result = await workItem(worker, item);
        say(
          { event: "item-result", itemId: item.itemId, epoch: item.epoch, ...result },
          () => `item ${item.itemId} ${result.summary.split("\n")[0] ?? ""} (${result.headSha})\n`,
        );
        return result;
      },
    });
  } catch (error) {
    joinView.close();
    throw error;
  }

  const stop = (): void => {
    abort.abort();
    void handle.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    showFingerprint(handle.fingerprint);
    const { sessionId, peerId } = handle;
    worker.peers = [{ peerId, device, role, state: "joined" }];
    joinView.update({
      peers: worker.peers,
      item: null,
      agent: null,
      tail: "",
      submit: { policy: method },
    });
    const at = formatHostPort(target);
    say(
      { event: "joined", sessionId, peerId, target: at },
      () => `joined session ${sessionId} at ${at} as ${peerId}\n`,
    );
    await handle.closed;
    say({ event: "closed" }, () => "session closed\n");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    abort.abort();
    reader?.close();
    joinView.close();
  }
}

/** This device's AGENT.md `agent_cli` (D27): the master's plan never names a CLI. */
async function agentCliOf(roleDir: string, view: AgentView): Promise<AgentCli> {
  try {
    return (await loadAgentMd(roleDir)).frontMatter.agent_cli;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new CliError(
      "agent_md",
      `--agent ${view} needs this device's AGENT.md (pass --role-dir): ${error.message}`,
      EXIT.usage,
    );
  }
}

const NotifyFileSchema = z.object({
  notify: z.object({ ntfy_topic_url: z.string() }).optional(),
});

/**
 * The ntfy notifier from `device.toml` `notify.ntfy_topic_url`, read as loosely as the submit
 * policy. No file or no topic means no notification; the stderr line is always printed.
 */
async function deviceNotifier(
  file: string,
  warn: (message: string) => void,
): Promise<(notification: Notification) => Promise<unknown>> {
  const none = async (): Promise<void> => {};
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return none;
    throw error;
  }
  try {
    const url = parseTomlConfig(NotifyFileSchema, text, file).notify?.ntfy_topic_url;
    if (url === undefined) return none;
    const notifier = new NtfyNotifier({ topicUrl: url, redactor: new Redactor() });
    return (notification) => notifier.notify(notification);
  } catch (error) {
    warn(`notifications disabled: ${errorMessage(error)}`);
    return none;
  }
}

/** Without `--ui`: today's output plus one stderr line per agent state change. */
class LineJoinView implements JoinView {
  private readonly shown = new Map<string, string>();

  constructor(
    private readonly out: { write(s: string): void },
    private readonly ask: (question: string) => Promise<string | null>,
    private readonly input: { pause(): void; resume(): void },
  ) {}

  update(model: JoinViewModel): void {
    const { item, agent } = model;
    if (item === null || agent === null) return;
    const watch =
      agent.focusCommand === undefined ? "" : `; watch with: ${agent.focusCommand.join(" ")}`;
    const line = `item ${item.itemId}: agent ${agent.cli} (${agent.view}) ${agent.state}${watch}\n`;
    const key = `${item.itemId}-e${item.epoch}`;
    if (this.shown.get(key) === line) return;
    this.shown.set(key, line);
    this.out.write(line);
  }

  async chooseSubmit(): Promise<"pr" | "mr" | "push" | "none" | null> {
    const answer = (await this.ask("Submit this item? [pr/mr/push/none/skip] "))?.trim() ?? "";
    return DIRECT_METHODS.find((value) => value === answer.toLowerCase()) ?? null;
  }

  /** The agent reads the terminal directly; a pending prompt must not steal its keystrokes. */
  async suspend(): Promise<void> {
    this.input.pause();
  }

  resume(): void {
    this.input.resume();
  }

  close(): void {}
}

/**
 * The "decide after the task" path: submits an item's local session branch. The master already
 * acked the result, so this never talks to it.
 */
async function submitCommand(
  ctx: SessionCliContext,
  itemId: string,
  opts: SubmitOptions,
): Promise<void> {
  if (!/^I-\d+$/.test(itemId)) {
    throw new CliError("bad_item", `invalid item id: ${JSON.stringify(itemId)}`, EXIT.usage);
  }
  const epoch = Number(opts.epoch);
  if (!/^\d+$/.test(opts.epoch) || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new CliError(
      "bad_epoch",
      `--epoch must be a positive integer, got ${opts.epoch}`,
      EXIT.usage,
    );
  }
  const branch = sessionBranch(itemId, epoch);
  let top: string;
  let headSha: string;
  try {
    top = (await git(ctx, ["rev-parse", "--show-toplevel"])).trim();
    headSha = (
      await git(ctx, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], top)
    ).trim();
  } catch (error) {
    throw new CliError(
      "no_branch",
      `no local session branch ${branch}; run this inside the joined repo (${errorMessage(error)})`,
    );
  }
  let submitted: { submit: SubmitOutcome; detail: string };
  if (opts.method === "skip") {
    submitted = { submit: outcome("ask", "skipped", branch), detail: "" };
  } else {
    const message = (await git(ctx, ["log", "-1", "--format=%B", headSha], top)).trim();
    const [subject = `session ${itemId}`, ...rest] = message.split("\n");
    submitted = await submitBranch(ctx, {
      cwd: top,
      branch,
      method: opts.method,
      title: subject,
      body: new Redactor().redact(rest.join("\n").trim() || subject),
    });
  }
  const { submit, detail } = submitted;
  const data = { itemId, epoch, branch, headSha, submit };
  const human = () => `${submitLine(submit)}${detail === "" ? "" : `\n${detail}`}\n`;
  if (submit.state === "failed") {
    ctx
      .output()
      .fail(new CliError("submit_failed", detail || `submitting ${branch} failed`), data, human);
    ctx.exitCode = EXIT.error;
    return;
  }
  ctx.output().result(data, human);
}

/** Sends one control op to the master named in `session.json` and returns its `result`. */
async function control(ctx: SessionCliContext, op: Record<string, unknown>): Promise<unknown> {
  const file = sessionFilePath(ctx);
  const local = await readSessionFile(file);
  if (local === null) {
    throw new CliError("no_session", `no session master is running (${file} not found)`);
  }
  const target = parseHostPort(local.listen);
  if (target === null) {
    throw new CliError("bad_session_file", `${file} has an invalid listen address`);
  }
  let reply: ControlResult;
  try {
    reply = await controlRequest(
      target,
      { type: "control", v: 1, token: local.token, ...op },
      systemClock,
    );
  } catch (error) {
    if (error instanceof ControlConnectionError) {
      throw new CliError("session_unreachable", error.message);
    }
    throw error;
  }
  if (!reply.ok) throw new CliError(reply.error.code, reply.error.message, EXIT.rejected);
  return reply.result;
}

function badReply(op: string, error: z.ZodError): CliError {
  return new CliError(
    "bad_reply",
    `session master sent a malformed ${op} result: ${error.message}`,
  );
}

async function intentCommand(
  ctx: SessionCliContext,
  text: string,
  repos: string[] | undefined,
): Promise<void> {
  if (text.length < 1 || text.length > MAX_INTENT_TEXT) {
    const message = `intent text must be 1..${MAX_INTENT_TEXT} chars`;
    throw new CliError("bad_intent", message, EXIT.usage);
  }
  if (repos !== undefined) {
    if (repos.length < 1 || repos.length > MAX_INTENT_REPOS) {
      throw new CliError("bad_repo", `--repo takes 1..${MAX_INTENT_REPOS} names`, EXIT.usage);
    }
    for (const repo of repos) validRepo(repo);
  }
  const result = await control(ctx, {
    op: "intent",
    text,
    ...(repos === undefined ? {} : { repos }),
  });
  const parsed = IntentResultSchema.safeParse(result);
  if (!parsed.success) throw badReply("intent", parsed.error);
  ctx.output().result(parsed.data, () => `${parsed.data.intentId}\n`);
}

async function statusCommand(ctx: SessionCliContext): Promise<void> {
  const result = await control(ctx, { op: "status" });
  const parsed = SessionStatusSchema.safeParse(result);
  if (!parsed.success) throw badReply("status", parsed.error);
  ctx.output().result(parsed.data, () => renderSessionStatus(parsed.data));
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
  }
  return rows
    .map((row) => `  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd())
    .join("\n");
}

export function renderSessionStatus(status: SessionStatus): string {
  const code = status.joinCode === null ? "none" : formatJoinCode(status.joinCode);
  const lines = [
    `session ${status.sessionId}  listen ${status.listen}  repo ${status.repo}`,
    `join code: ${code}${expiryText(status.joinCodeExpiresAtMs)}`,
    "",
  ];
  if (status.peers.length === 0) {
    lines.push("peers: none");
  } else {
    lines.push("peers:");
    lines.push(
      table([
        ["PEER", "DEVICE", "ADDRESS", "REPO", "HEAD", "ROLE"],
        ...status.peers.map((p) => [
          p.peerId,
          p.device,
          p.address,
          p.repo ?? "-",
          p.head === null ? "-" : p.head.slice(0, 12),
          p.role ?? "-",
        ]),
      ]),
    );
  }
  lines.push("");
  if (status.intents.length === 0) {
    lines.push("intents: none");
  } else {
    lines.push("intents:");
    for (const intent of status.intents) {
      lines.push(`  ${intent.intentId}  ${intent.state}  ${intent.text}`);
      if (intent.items.length > 0) {
        lines.push(
          table(
            intent.items.map((item) => [
              `  ${item.itemId}`,
              item.state,
              item.repo,
              item.assignee,
              item.result?.submit === undefined
                ? "-"
                : `${item.result.submit.method}:${item.result.submit.state}`,
              item.title,
            ]),
          ),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
