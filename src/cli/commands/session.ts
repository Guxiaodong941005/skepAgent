/**
 * `skep session` — the CLI surface of session mode (in-memory master/sub channel on one TCP port).
 *
 * The protocol engine lives in `src/session/`. Commands reach it through the {@link SessionApi}
 * subset declared below, so tests can inject `sessionApi` on the context instead.
 *
 * A joined sub works its items here, one at a time, in its own project folder: no worktree, clone
 * or session branch (docs/plans/session-ux-rethink.md, SESSION-UX). It runs the agent resolved at
 * join, reports which files changed, runs one trusted check, and submits by this device's own
 * policy (default: leave the edits in the folder). The master only learns the outcome.
 *
 * `intent` and `status` talk to a running master over the plaintext control frame, authenticated
 * by the token in `${SKEP_HOME}/session.json`. The master writes that file after it binds and
 * removes it on clean exit.
 */

import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { type Command, Option } from "commander";
import { z } from "zod";
import { loadAgentMd } from "../../config/agent-md.js";
import { ConfigError, parseTomlConfig } from "../../config/errors.js";
import { resolveProjectRoot } from "../../config/paths.js";
import { type AgentCliSchema, RepoRefSchema, ShaSchema } from "../../core/schemas/common.js";
import { CHECKS_FILE_PATH, ChecksFileSchema } from "../../core/schemas/config.js";
import { Redactor } from "../../exec/redact.js";
import { type Notification, NtfyNotifier } from "../../notify/ntfy.js";
import type { ProcessExit } from "../../runtime/types.js";
import {
  connectSub,
  type DatalistEntry,
  ListenAddressError,
  type MasterHandle,
  type MasterOptions,
  type PeerPhase,
  type PeerProgress,
  type PlanItem,
  type SubHandle,
  type SubmitMethod,
  type SubmitOutcome,
  SubmitOutcomeSchema,
  type SubOptions,
  type SubResult,
  startMaster,
} from "../../session/index.js";
import { intentRollup, itemBlock, itemVerdict } from "../../session/master.js";
import { type Clock, isoUtc, systemClock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import { atomicWrite, safeJoin } from "../../util/fs.js";
import { cryptoRandom } from "../../util/random.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import { quoteSlashWord } from "../shell/flags.js";
import {
  changedLine,
  computeDelta,
  DeltaError,
  type DeltaRecord,
  driftedFiles,
  type ItemDelta,
  readDeltaRecord,
  runLabel,
  type SnapshotIo,
  snapshotTree,
  type TreeSnapshot,
  type UndoOutcome,
  UndoRefusedError,
  undoDelta,
  writeDeltaRecord,
} from "./session-delta.js";

export const DEFAULT_PORT = 7419;
/** Bounded automatic selection; explicit listen addresses never enter this scan. */
export const LAST_AUTO_PORT = DEFAULT_PORT + 100;
const SESSION_FILE = "session.json";
/** A stale `session.json` must not hang `start`; a live master answers well within this. */
const PROBE_TIMEOUT_MS = 2_000;
const CONTROL_TIMEOUT_MS = 10_000;
/**
 * An `intent` op is answered only after routing, which may wait out the master's 30 s datalist
 * timeout for capabilities; a shorter wait reports a live master as unreachable.
 */
const INTENT_CONTROL_TIMEOUT_MS = 40_000;
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

export type { PeerPhase, PeerProgress, SubHandle, SubOptions };

export interface SessionApi {
  startMaster(options: MasterOptions): Promise<MasterHandle>;
  connectSub(options: SubOptions): Promise<SubHandle>;
}

export type { DatalistEntry, MasterHandle, MasterOptions, PlanItem };

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

const PeerProgressSchema = z
  .strictObject({
    phase: z.enum(["idle", "working", "blocked", "done"]),
    done: z.number().int().nonnegative().max(10_000),
    total: z.number().int().nonnegative().max(10_000),
    failed: z.number().int().nonnegative().max(10_000),
    percent: z.number().int().min(0).max(100),
    summary: z.string().max(120),
    itemId: z
      .string()
      .regex(/^I-\d+$/)
      .optional(),
  })
  .refine(
    (progress) => progress.done <= progress.total && progress.failed <= progress.done,
    "done ≤ total and failed ≤ done",
  )
  .refine(
    (progress) =>
      progress.percent ===
      (progress.total === 0 ? 0 : Math.floor((100 * progress.done) / progress.total)),
    "percent must equal floor(100*done/total)",
  );

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
      progress: PeerProgressSchema.optional(),
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
  /**
   * True once the request was handed to the socket: the master may have acted on it even though
   * no reply arrived (closed after write, timeout, malformed reply). False means it never left.
   */
  readonly requestSent: boolean;

  constructor(target: string, reason: string, options?: ErrorOptions & { requestSent?: boolean }) {
    super(`session master at ${target}: ${reason}`, options);
    this.name = "ControlConnectionError";
    this.requestSent = options?.requestSent ?? false;
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
    let written = false;
    const finish = (error: Error | null, reply?: ControlResult): void => {
      if (settled) return;
      settled = true;
      timer.abort();
      socket.destroy();
      if (error !== null) reject(error);
      else if (reply !== undefined) resolve(reply);
    };
    clock.sleep(timeoutMs, timer.signal).then(
      () =>
        finish(
          new ControlConnectionError(label, `no reply within ${timeoutMs} ms`, {
            requestSent: written,
          }),
        ),
      // Aborted because the exchange finished first.
      () => undefined,
    );
    socket.on("connect", () => {
      written = true;
      socket.write(encodeFrame(Buffer.from(JSON.stringify(request), "utf8")));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        const [frame] = decoder.push(chunk);
        if (frame === undefined) return;
        const parsed = ControlResultSchema.safeParse(JSON.parse(frame.toString("utf8")));
        if (!parsed.success) {
          finish(
            new ControlConnectionError(label, "malformed control-result", { requestSent: true }),
          );
          return;
        }
        finish(null, parsed.data);
      } catch (error) {
        finish(
          new ControlConnectionError(label, errorMessage(error), {
            cause: error,
            requestSent: true,
          }),
        );
      }
    });
    socket.on("error", (error) => {
      finish(
        new ControlConnectionError(label, error.message, { cause: error, requestSent: written }),
      );
    });
    socket.on("close", () => {
      finish(
        new ControlConnectionError(label, "connection closed before a reply", {
          requestSent: written,
        }),
      );
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

/**
 * `host:port` naming one address: `--listen` binds it, `--advertise` is what peers dial. The one
 * check for both, run before any master starts.
 */
function concreteHostPort(flag: string, value: string): HostPort {
  const parsed = parseHostPort(value);
  if (parsed === null) {
    throw new CliError("bad_listen", `${flag} must be host:port, got ${value}`, EXIT.usage);
  }
  const problem = hostProblem(parsed.host);
  if (problem === "wildcard") {
    // A wildcard bind would expose the join handshake and control port on every interface, and
    // a wildcard advertise is no address a peer can dial.
    throw new CliError(
      "bad_listen",
      `${flag} must name one interface address, not a wildcard`,
      EXIT.usage,
    );
  }
  if (problem === "malformed") {
    throw new CliError(
      "bad_listen",
      `${flag} must name a hostname or IP address, got ${JSON.stringify(parsed.host)}`,
      EXIT.usage,
    );
  }
  return parsed;
}

/** One DNS label: 1..63 characters, no leading or trailing `-` (`_` tolerated, as resolvers do). */
const DNS_LABEL_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
/** An IPv6 zone id (`fe80::1%eth0`). */
const ZONE_RE = /^[A-Za-z0-9._-]+$/;

/** Unspecified addresses: binding one means every interface, and nobody can dial one. */
const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addAddress("0.0.0.0", "ipv4");
UNSPECIFIED.addAddress("::", "ipv6");
UNSPECIFIED.addAddress("::ffff:0.0.0.0", "ipv6");

/**
 * Why `host` is not one concrete address, or null. IPs are checked by Node's own parser, not by
 * character classes; an IPv6 zone id is split off first, so `[::%eth0]` is still a wildcard.
 */
function hostProblem(host: string): "wildcard" | "malformed" | null {
  if (host === "*") return "wildcard";
  if (host.includes(":")) {
    // Only a bracketed `[v6]:port` yields a host with colons (see parseHostPort).
    const at = host.indexOf("%");
    const address = at < 0 ? host : host.slice(0, at);
    if (at >= 0 && !ZONE_RE.test(host.slice(at + 1))) return "malformed";
    if (!net.isIPv6(address)) return "malformed";
    return UNSPECIFIED.check(address, "ipv6") ? "wildcard" : null;
  }
  if (net.isIPv4(host)) return UNSPECIFIED.check(host, "ipv4") ? "wildcard" : null;
  // Digits and dots that are no valid IPv4 (`0`, `999.1.1.1`, `1.2.3`) are not a hostname either.
  if (/^[\d.]+$/.test(host)) return /^0+$/.test(host) ? "wildcard" : "malformed";
  if (host.length > 253) return "malformed";
  return host.split(".").every((label) => DNS_LABEL_RE.test(label)) ? null : "malformed";
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

export interface JoinTarget {
  /** `host:port` peers dial (the master's advertise address, else its listen address). */
  host: string;
  code: string;
  repo: string;
}

/**
 * A repo the paste line can carry. Control characters (a newline would submit the input early)
 * cannot be typed into the shell's input box, so such a repo is left out and named instead.
 */
function pasteableRepo(repo: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
  return !/[\u0000-\u001f\u007f]/.test(repo);
}

/**
 * The one line a peer pastes into its skep shell to join (docs/plans/join-paste-auto.md). Each
 * value is quoted for the slash grammar, so `parseJoinArgs` reads back exactly these values.
 */
export function formatJoinPaste({ host, code, repo }: JoinTarget): string {
  const base = `/join --host ${quoteSlashWord(host)} --code ${formatJoinCode(code)}`;
  return pasteableRepo(repo) ? `${base} --repo ${quoteSlashWord(repo)}` : base;
}

/** A POSIX shell word: bare when safe, else single-quoted. */
export function quoteShellWord(value: string): string {
  if (/^[A-Za-z0-9._/:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The same join for a plain shell; every argument is shell-quoted. */
export function formatJoinCli({ host, code, repo }: JoinTarget): string {
  return [
    "skep session join --host",
    quoteShellWord(host),
    "--code",
    formatJoinCode(code),
    "--repo",
    quoteShellWord(repo),
  ].join(" ");
}

/** What a master prints so a peer can join: the paste line first, then its CLI twin. */
export function joinHint(target: JoinTarget): string {
  const note = pasteableRepo(target.repo)
    ? ""
    : `\n(repo ${JSON.stringify(target.repo)} cannot be pasted: join from that checkout, ` +
      "whose directory name is the default --repo)";
  return (
    `on another device, paste into skep: ${formatJoinPaste(target)}${note}\n` +
    `or from a shell: ${formatJoinCli(target)}`
  );
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
  return parseSessionFile(file, raw);
}

function parseSessionFile(file: string, raw: string): SessionFile {
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
// Sub-side item work: snapshot, execute, report the delta, check, submit.
//
// A sub and the master do not share a repo, so what happens to a finished item's code is decided
// here, by this device's own policy or the human at it. The master only records the outcome.

/** `commit` is device-local: the wire carries it as `none`/`local` (no schema change). */
export const SUBMIT_METHODS = ["commit", "pr", "mr", "push", "none", "ask"] as const;
export type LocalSubmitMethod = (typeof SUBMIT_METHODS)[number];
const SUBMIT_COMMAND_METHODS = ["commit", "pr", "mr", "push", "none", "skip"] as const;
const DIRECT_METHODS = ["pr", "mr", "push", "none"] as const;
type DirectMethod = (typeof DIRECT_METHODS)[number];

const AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUMMARY = 4_000;
/** What `--view dry` reports: it is never mistaken for work (SESSION-UX §3.2). */
export const DRY_RUN_SUMMARY = "DRY RUN: no agent ran, nothing changed";
/** Sent with every item so the agent edits in place and ends with something to show. */
const PROMPT_PREAMBLE =
  "Work directly in the current directory. End with a brief summary of what you changed.";
/** Unknown local HEAD; capability and failed-result SHAs must still satisfy the wire schema. */
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
    method: z.enum(SUBMIT_METHODS).default("none"),
    host: z.enum(["github", "gitlab", "git"]).default("github"),
  })
  .default({ method: "none", host: "github" });
export type SubmitPolicy = z.infer<typeof SubmitPolicySchema>;
const DevicePolicyFileSchema = z.object({ submit: SubmitPolicySchema });

const DEFAULT_POLICY: SubmitPolicy = { method: "none", host: "github" };

/**
 * Submit policy from `device.toml`. A missing file, a missing key, or a file that does not parse
 * all mean `none`: the work stays committed locally and nobody is prompted after every item
 * (`ask` is opt-in). A plain git host has no PR/MR concept, so it forces `push`.
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
    warn(`ignoring submit policy (${error.message}); falling back to none`);
    return DEFAULT_POLICY;
  }
  // `commit` never talks to a host, so a plain git host leaves it alone.
  return policy.host === "git" && policy.method !== "commit"
    ? { ...policy, method: "push" }
    : policy;
}

/** The branch name skep ≤ 0.1.10 used for an item; only `submit` still recognises it. */
export function legacySessionBranch(itemId: string, epoch: number): string {
  return `skep/session/${itemId}-e${epoch}`;
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

/**
 * The folder the agent edits: the git top level of the joined directory, else that directory
 * itself (SAME-CB: a repo without HEAD, or no repo at all, still works).
 */
export async function projectRoot(ctx: SessionCliContext): Promise<string> {
  const cwd = ctx.cwd ?? process.cwd();
  return resolveProjectRoot(cwd, pickEnv(ctx, ["PATH", "HOME"])).catch(() => path.resolve(cwd));
}

/** The checked-out branch, or `HEAD` when detached, unborn without a name, or not a repo. */
async function currentBranch(ctx: SessionCliContext, dir: string): Promise<string> {
  const name = await git(ctx, ["symbolic-ref", "--short", "-q", "HEAD"], dir).then(
    (value) => value.trim(),
    () => "",
  );
  return name === "" ? "HEAD" : name;
}

function snapshotIo(ctx: SessionCliContext): SnapshotIo {
  return {
    git: (args, cwd) => git(ctx, args, cwd),
    env: pickEnv(ctx, ["PATH", "HOME"]),
    // A home inside the project (SKEP_HOME pointed there) holds transcripts, never results.
    exclude: ctx.paths === undefined ? [] : [ctx.paths.home],
  };
}

/** `2m 14s`, `12s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Writes the full, untruncated (but redacted) text of a failure next to the session state and
 * returns its path, so the scrollback can stay at one cause and one fix (SESSION-UX §3.4).
 */
export async function writeLastError(home: string, text: string): Promise<string> {
  const file = path.join(home, "session", "last-error.log");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${new Redactor().redact(text).trimEnd()}\n`, { mode: 0o600 });
  return file;
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
  peers: {
    peerId: string;
    device: string;
    role: string;
    state: string;
    progress?: Pick<PeerProgress, "done" | "total" | "failed" | "percent" | "summary"> & {
      phase: PeerPhase;
    };
  }[];
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
  chooseSubmit(model: JoinViewModel): Promise<"commit" | "pr" | "mr" | "push" | "none" | null>;
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
/** Pause between checks on a blocked herdr agent that still holds the item queue. */
const BLOCKED_POLL_MS = 2_000;
const HERDR_READ_LINES = 200;
/** Only this much of a transcript is cleaned for the summary; the file keeps everything. */
const TAIL_WINDOW = 64 * 1024;

/**
 * `--view` wins, then `SKEP_SESSION_VIEW`, otherwise native. A real agent run is the default:
 * there is no silent dry fallback, and `SKEP_SESSION_EXEC` no longer switches anything on
 * (SESSION-UX §3.2, Phase 2).
 */
export function selectAgentView(flag: AgentView | undefined, env: NodeJS.ProcessEnv): AgentView {
  if (flag !== undefined) return flag;
  return AGENT_VIEWS.find((view) => view === env.SKEP_SESSION_VIEW) ?? "native";
}

const AGENT_CLIS_ENUM = ["claude", "codex", "pi"] as const;
export const AGENT_CLIS = AGENT_CLIS_ENUM satisfies readonly AgentCli[];

function isAgentCli(value: string | undefined): value is AgentCli {
  return AGENT_CLIS.some((cli) => cli === value);
}

function isAgentView(value: string | undefined): value is AgentView {
  return AGENT_VIEWS.some((view) => view === value);
}

/**
 * A `--agent` value: the agent CLI. The pre-SESSION-UX view names (`pty`, `native`, `herdr`,
 * `dry`) are refused with the flag that replaced them, so an old command line fails loudly
 * instead of silently running something else.
 */
export function parseAgentFlag(value: string | undefined): { cli?: AgentCli } {
  if (value === undefined) return {};
  if (isAgentCli(value)) return { cli: value };
  if (isAgentView(value)) {
    throw new CliError(
      "bad_agent",
      `--agent ${value} is now --view ${value}; --agent takes the agent CLI (${AGENT_CLIS.join(", ")})`,
      EXIT.usage,
    );
  }
  throw new CliError(
    "bad_agent",
    `--agent must be ${AGENT_CLIS.join(", ")} (the agent CLI), got ${value}`,
    EXIT.usage,
  );
}

/**
 * Where the agent CLI of a join came from, in resolution order (SESSION-UX §3.2). `/agent` is
 * this device's setting: `device.toml` `[agent] cli`, which the shell's `/agent` writes.
 */
export type AgentSource = "--agent" | "/agent" | "SKEP_AGENT_CLI" | "AGENT.md" | "PATH";

const AgentSettingFileSchema = z.object({
  agent: z.object({ cli: z.enum(AGENT_CLIS_ENUM) }).optional(),
});

/**
 * This device's agent CLI from `device.toml` `[agent] cli`, read as loosely as the submit policy:
 * no file or no key is no setting; a value that does not parse is a warning, never a block.
 */
export async function loadAgentSetting(
  file: string,
  warn: (message: string) => void = () => {},
): Promise<AgentCli | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseTomlConfig(AgentSettingFileSchema, text, file).agent?.cli;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    warn(`ignoring the [agent] setting (${error.message})`);
    return undefined;
  }
}

/**
 * Writes `[agent] cli = "<cli>"` into `device.toml`, keeping every other line as it was: the
 * key is replaced inside an existing `[agent]` table, added to it, or the table is appended.
 */
export async function saveAgentSetting(file: string, cli: AgentCli): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const entry = `cli = "${cli}"`;
  const header = lines.findIndex((line) => /^\s*\[agent\]\s*(#.*)?$/.test(line));
  if (header < 0) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push("[agent]", entry);
  } else {
    let end = lines.findIndex((line, i) => i > header && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
    const key = lines.findIndex((line, i) => i > header && i < end && /^\s*cli\s*=/.test(line));
    if (key >= 0) lines[key] = entry;
    else lines.splice(header + 1, 0, entry);
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export interface ResolvedAgent {
  cli: AgentCli;
  source: AgentSource;
}

export function agentSourceText(source: AgentSource): string {
  return source === "PATH" ? "found on PATH" : `from ${source}`;
}

export const NO_AGENT_MESSAGE =
  `no agent CLI found (looked for ${AGENT_CLIS.join(", ")} on PATH)\n` +
  "fix: install one, or pass --agent <claude|codex|pi> (in the skep shell: /agent <cli>)";

/**
 * This device's agent CLI, decided once at join so the human learns immediately: `--agent`, then
 * `/agent`, then `SKEP_AGENT_CLI`, then an AGENT.md that happens to exist (never required), then
 * the first of claude, codex, pi on PATH. No agent is an error: the peer never joins without one.
 * The master never chooses the CLI (D27).
 */
export async function resolveAgentCli(input: {
  flag?: AgentCli;
  setting?: AgentCli;
  /** `device.toml`, read for `[agent] cli` when no `setting` was passed. */
  deviceToml?: string;
  env: NodeJS.ProcessEnv;
  /** Where an AGENT.md might be. */
  dir: string;
  warn(message: string): void;
}): Promise<ResolvedAgent> {
  const { env } = input;
  const setting =
    input.setting ??
    (input.flag === undefined && input.deviceToml !== undefined
      ? await loadAgentSetting(input.deviceToml, input.warn)
      : undefined);
  let chosen: ResolvedAgent | null = null;
  if (input.flag !== undefined) chosen = { cli: input.flag, source: "--agent" };
  else if (setting !== undefined) chosen = { cli: setting, source: "/agent" };
  else if (env.SKEP_AGENT_CLI !== undefined && env.SKEP_AGENT_CLI !== "") {
    if (!isAgentCli(env.SKEP_AGENT_CLI)) {
      throw new CliError(
        "bad_agent",
        `SKEP_AGENT_CLI=${env.SKEP_AGENT_CLI} is not one of ${AGENT_CLIS.join(", ")}\n` +
          "fix: set it to claude, codex or pi, or unset it",
        EXIT.usage,
      );
    }
    chosen = { cli: env.SKEP_AGENT_CLI, source: "SKEP_AGENT_CLI" };
  } else if (await exists(path.join(input.dir, "AGENT.md"))) {
    try {
      chosen = { cli: (await loadAgentMd(input.dir)).frontMatter.agent_cli, source: "AGENT.md" };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // Back-compat only: a broken AGENT.md never blocks a join that auto-detect can serve.
      input.warn(`ignoring AGENT.md (${error.message})`);
    }
  }
  if (chosen !== null) {
    if (!(await onPath(chosen.cli, env))) {
      throw new CliError(
        "no_agent",
        `agent ${chosen.cli} (${agentSourceText(chosen.source)}) is not on PATH\n` +
          `fix: install ${chosen.cli}, or choose another with --agent <claude|codex|pi>`,
        EXIT.usage,
      );
    }
    return chosen;
  }
  for (const cli of AGENT_CLIS) {
    if (await onPath(cli, env)) return { cli, source: "PATH" };
  }
  throw new CliError("no_agent", NO_AGENT_MESSAGE, EXIT.usage);
}

/** How a joined device runs its agent. */
export interface AgentSetup {
  view: AgentView;
  /** Resolved at join on this device; the master never chooses it (D27). */
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

/**
 * One item's agent outcome. `summary` is the cleaned, redacted text for the master; `full` is
 * everything the agent printed, for `last-error.log` only. A failure carries one cause and one
 * fix (SESSION-UX §3.4).
 */
type Executed = (
  | { status: "ok" }
  | { status: "dry" }
  | { status: "failed"; cause: string; fix: string }
  | {
      status: "blocked";
      /** Resolves with how the agent ended once it is no longer blocked; rejects when aborted. */
      settle?: () => Promise<string>;
    }
) & {
  summary: string;
  full: string;
  /** The agent's own closing words ({@link agentSummary}), when it said anything. */
  said?: string;
};

/** One agent run's raw outcome, before commit and cleaning. `tail` is local, unredacted text. */
interface AgentRun {
  ok: boolean;
  status: string;
  tail: string;
  blocked?: {
    name: string;
    focusCommand: readonly string[];
    settle: () => Promise<string>;
  };
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
    const clock = run.worker.clock ?? systemClock;
    const signal = run.worker.signal;
    // The agent still owns the folder: the human may answer it and it resumes editing. This
    // only watches it; it never answers (D29). A closing join aborts the watch (R4).
    const settle = async (): Promise<string> => {
      for (;;) {
        await clock.sleep(BLOCKED_POLL_MS, signal);
        let next: AgentViewState;
        try {
          next = await backend.wait(handle, {
            timeoutMs: HERDR_WAIT_MS,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          if (signal?.aborted === true) throw error;
          // A failed or timed-out wait is not completion: the agent may still be editing the
          // folder. Only a confirmed pane close releases the queue; until then keep holding and
          // retry, so the next item never runs beside it (R10).
          const closed = await backend
            .close(handle)
            .then(() => true)
            .catch(() => false);
          if (closed) return `lost (${errorMessage(error)}); skep closed its pane`;
          continue;
        }
        if (next !== "blocked") return next;
      }
    };
    return {
      ok: false,
      status: "blocked",
      tail,
      blocked: { name: handle.name, focusCommand: handle.focusCommand, settle },
    };
  }
  const ok = state === "done" || state === "idle";
  return { ok, status: ok ? `${state}` : `stopped in state ${state}`, tail };
}

/**
 * Runs the item with the worker's strategy in `dir`, the project folder itself. Nothing is
 * committed here: the delta is measured by the caller. herdr falls back to native only on a
 * `fallbackSafe` error, PTY only when the PTY could not start (D28); the reason is printed.
 */
async function executeItem(
  worker: ItemWorker,
  item: PlanItem,
  dir: string,
  report: RunContext["report"],
): Promise<Executed> {
  const { ctx } = worker;
  const setup = worker.agent;
  if (setup === undefined) {
    // A join always resolves an agent; reaching this is a wiring bug, reported, never faked.
    return {
      status: "failed",
      summary: "",
      cause: "no agent CLI is configured on this device",
      fix: "leave and /join again with --agent <claude|codex|pi>",
      full: "",
    };
  }
  if (setup.view === "dry") return { status: "dry", summary: DRY_RUN_SUMMARY, full: "" };

  const run: RunContext = {
    worker,
    setup,
    item,
    dir,
    // The item title is the task; the preamble keeps the agent in place and asks for a summary.
    prompt: `${item.title}\n\n${PROMPT_PREAMBLE}\n`,
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
  try {
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
  } catch (error) {
    return spawnFailure(setup, error, "");
  }
  let note = "";
  if (agent === null) {
    note = `${fallback}; ran ${setup.cli} non-interactively\n`;
    ctx.stderr.write(`skep: item ${item.itemId}: ${note}`);
    run.transcript = run.transcript.replace(/-[a-z]+\.log$/, "-native.log");
    try {
      agent = await runNative(run);
    } catch (error) {
      return spawnFailure(setup, error, note);
    }
  }

  const strip = runtime?.stripTerminalControls ?? dropControlChars;
  const tail = summaryTail(agent.tail, strip);
  const full = `${note}agent ${agent.status}\n${strip(agent.tail)}`;
  const said = agentSummary(tail);
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
      settle: agent.blocked.settle,
      summary: `${note}${waiting}\nfinish in the pane; its edits land in ${dir} directly\n${tail}`,
      full,
      said,
    };
  }
  if (!agent.ok) {
    const timedOut = agent.status === "timed out";
    return {
      status: "failed",
      summary: `${note}${tail}`,
      cause: timedOut
        ? `agent ${setup.cli} timed out after ${formatDuration(AGENT_TIMEOUT_MS)}`
        : `agent ${setup.cli} ${agent.status}`,
      fix: timedOut
        ? "split the intent into smaller steps, or join with --view pty to watch it"
        : "read the agent's output below, fix the cause on this device, then send the intent again",
      full,
      said,
    };
  }
  return { status: "ok", summary: `${note}agent ${agent.status}\n${tail}`, full, said };
}

/** The agent could not even start: name the missing binary rather than a raw spawn error. */
function spawnFailure(setup: AgentSetup, error: unknown, note: string): Executed {
  let missing = false;
  // execFileChecked wraps the spawn error; its `cause` carries the errno.
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if ((at as NodeJS.ErrnoException).code === "ENOENT") missing = true;
  }
  return {
    status: "failed",
    summary: note,
    cause: missing
      ? `agent CLI ${setup.cli} not found on PATH`
      : `agent ${setup.cli} could not run: ${errorMessage(error)}`,
    fix: missing
      ? `install ${setup.cli}, or leave and /join again with --agent <claude|codex|pi>`
      : "check that the agent CLI runs in a terminal on this device, then send the intent again",
    full: `${note}${errorMessage(error)}`,
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

function submitLine(submit: SubmitOutcome): string {
  return `submit ${submit.method} ${submit.state}${submit.url === undefined ? "" : ` ${submit.url}`}`;
}

/** A git identity for commits skep makes, only when the repo has none configured. */
async function commitIdentity(ctx: SessionCliContext, dir: string): Promise<string[]> {
  const configured = await git(ctx, ["config", "user.email"], dir).then(
    (value) => value.trim() !== "",
    () => false,
  );
  return configured ? [] : ["-c", "user.name=skep", "-c", "user.email=skep@example.invalid"];
}

/** The delta paths git can stage: present now, or tracked (a deletion). */
async function stageablePaths(ctx: SessionCliContext, dir: string, paths: readonly string[]) {
  const tracked = new Set(
    (await git(ctx, ["ls-files", "-z", "--", ...paths], dir)).split("\0").filter(Boolean),
  );
  const out: string[] = [];
  for (const rel of paths) {
    if (tracked.has(rel) || (await exists(path.join(dir, rel)))) out.push(rel);
  }
  return out;
}

/**
 * Commits exactly the item's files on the current branch (`--only`), whatever else is staged or
 * dirty. A file the user had already modified is committed with their edits too: the working
 * tree holds one version of it. Returns the new commit, or null when nothing was left to commit.
 */
async function commitDelta(
  ctx: SessionCliContext,
  dir: string,
  paths: readonly string[],
  message: string,
): Promise<string | null> {
  const files = await stageablePaths(ctx, dir, paths);
  if (files.length === 0) return null;
  // The agent (or an earlier `submit commit`) may have committed them already: a commit would
  // fail with "nothing to commit" and stop a requested push (R5).
  const pending = await git(
    ctx,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files],
    dir,
  );
  if (pending === "") return null;
  await git(ctx, ["add", "-A", "--", ...files], dir);
  const identity = await commitIdentity(ctx, dir);
  await git(
    ctx,
    [...identity, "commit", "--quiet", "--no-verify", "-m", message, "--only", "--", ...files],
    dir,
  );
  return (await git(ctx, ["rev-parse", "HEAD"], dir)).trim();
}

/** `skep/<itemId>-<slug>` for a PR/MR, made unique against existing branches. */
async function submitBranchName(
  ctx: SessionCliContext,
  dir: string,
  itemId: string,
  title: string,
): Promise<string> {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const base = `skep/${itemId}${slug === "" ? "" : `-${slug}`}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const taken = await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], dir)
      .then(() => true)
      .catch(() => false);
    if (!taken) return name;
  }
}

/**
 * A commit of the item's files on top of HEAD, written through a private index so neither the
 * working tree, the real index nor the checked-out branch moves: the edits stay in the folder
 * and the PR branch gets a copy. This is the only place a session branch is ever created, and
 * only for an opted-in `pr`/`mr` (SESSION-UX §3.3).
 */
async function branchFromDelta(
  ctx: SessionCliContext,
  dir: string,
  branch: string,
  paths: readonly string[],
  message: string,
): Promise<string> {
  const index = path.resolve(
    dir,
    (
      await git(
        ctx,
        ["rev-parse", "--git-path", `skep-submit-${branch.replace(/\//g, "-")}.index`],
        dir,
      )
    ).trim(),
  );
  const env = { ...pickEnv(ctx, ["PATH", "HOME"]), GIT_INDEX_FILE: index };
  const run = async (args: string[]): Promise<string> =>
    (await execFileChecked("git", args, { env, cwd: dir })).stdout;
  const head = await git(ctx, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], dir)
    .then((value) => value.trim())
    .catch(() => "");
  try {
    await run(head === "" ? ["read-tree", "--empty"] : ["read-tree", head]);
    await run(["update-index", "--add", "--remove", "--", ...paths]);
    const tree = (await run(["write-tree"])).trim();
    const identity = await commitIdentity(ctx, dir);
    const parent = head === "" ? [] : ["-p", head];
    const commit = (await run([...identity, "commit-tree", tree, ...parent, "-m", message])).trim();
    // Create-only: an existing branch of that name is never moved.
    await run(["update-ref", `refs/heads/${branch}`, commit, "0".repeat(40)]);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

/** Submit methods a device can apply to an item's delta; `commit` never leaves the device. */
export type DeltaMethod = DirectMethod | "commit";

export interface SubmitDeltaOptions {
  dir: string;
  itemId: string;
  method: DeltaMethod;
  paths: readonly string[];
  title: string;
  body: string;
  /**
   * The recorded delta the paths come from. Every file must still hold the content the item
   * left, or nothing is staged, committed or published (R3).
   */
  record?: DeltaRecord;
}

export interface SubmittedDelta {
  /** The wire outcome. `commit` is sent as `none`/`local`: the wire has no commit method. */
  submit: SubmitOutcome;
  /** The human line, first in the summary: `submit commit local abc1234 on main`. */
  line: string;
  detail: string;
}

/**
 * Applies a submit method to an item's changed files (SESSION-UX §3.3). `none` leaves them in the
 * working tree; `commit` commits only them on the current branch; `push` also pushes that branch;
 * `pr`/`mr` copy them onto a new `skep/<itemId>-<slug>` branch, push it and open the PR/MR without
 * touching the working tree. Every failure is a `failed` outcome, never an exception.
 */
export async function submitDelta(
  ctx: SessionCliContext,
  opts: SubmitDeltaOptions,
): Promise<SubmittedDelta> {
  const { dir, method } = opts;
  const current = await currentBranch(ctx, dir);
  const line = (submit: SubmitOutcome, label: string = submit.method): string =>
    `submit ${label} ${submit.state}${submit.url === undefined ? "" : ` ${submit.url}`}`;
  const done = (submit: SubmitOutcome, detail = "", label?: string): SubmittedDelta => ({
    submit,
    line: line(submit, label),
    detail,
  });
  if (method === "none") return done(outcome("none", "local", current));
  const wire = method === "commit" ? "none" : method;
  if (opts.record !== undefined) {
    const drifted = await driftedFiles(opts.record).catch((error: unknown) => [
      `(could not read the files: ${errorMessage(error)})`,
    ]);
    if (drifted.length > 0) {
      return done(
        outcome(wire, "failed", current),
        `${drifted.join(", ")} changed after ${runLabel(opts.record)} (by a later item or by ` +
          "hand), so its content is no longer the item's; nothing was staged, committed or " +
          "pushed. Commit those files with git yourself, or submit the item that changed them last",
        method,
      );
    }
  }
  const message = opts.title === "" ? `session ${opts.itemId}` : opts.title;
  const fullMessage = opts.body === "" ? message : `${message}\n\n${opts.body}`;
  try {
    if (method === "commit" || method === "push") {
      const sha = await commitDelta(ctx, dir, opts.paths, fullMessage);
      if (method === "commit") {
        const submit = outcome("none", "local", current);
        if (sha === null) {
          const head = (await git(ctx, ["rev-parse", "--short=7", "HEAD"], dir)).trim();
          return {
            submit,
            line: `submit commit local ${head} on ${current}`,
            detail: "nothing left to commit: the item's changes are already committed",
          };
        }
        return { submit, line: `submit commit local ${sha.slice(0, 7)} on ${current}`, detail: "" };
      }
      if (current === "HEAD") {
        return done(outcome("push", "failed", current), "detached HEAD: no branch to push");
      }
      return pushBranch(ctx, dir, method, current, done);
    }
    const host = method === "pr" ? "gh" : "glab";
    if (!(await onPath(host, ctx.env))) {
      return done(
        outcome(method, "local", current),
        `${host} is not on PATH; nothing was committed, the edits stay in ${dir}`,
      );
    }
    const branch = await submitBranchName(ctx, dir, opts.itemId, opts.title);
    await branchFromDelta(ctx, dir, branch, opts.paths, fullMessage);
    const pushed = await pushBranch(ctx, dir, method, branch, done);
    if (pushed.submit.state !== "pushed") return pushed;
    const base = await defaultBranch(ctx, dir);
    const args =
      host === "gh"
        ? ["pr", "create", "--head", branch, "--base", base, "--title", message]
        : ["mr", "create", "--source-branch", branch, "--target-branch", base, "--title", message];
    args.push(host === "gh" ? "--body" : "--description", opts.body);
    const created = await execFileChecked(host, args, {
      cwd: dir,
      env: pickEnv(ctx, HOST_ENV_KEYS),
      allowFailure: true,
    }).catch((error: unknown) => ({ code: null, stdout: "", stderr: errorMessage(error) }));
    if (created.code !== 0) return done(outcome(method, "failed", branch), created.stderr.trim());
    const opened = openedFrom(created.stdout);
    // Created but no URL to show for it: the branch is at least pushed.
    if (opened === null) return done(outcome(method, "pushed", branch));
    return done(outcome(method, "opened", branch, opened));
  } catch (error) {
    return done(outcome(wire, "failed", current), errorMessage(error), method);
  }
}

async function pushBranch(
  ctx: SessionCliContext,
  dir: string,
  method: DirectMethod,
  branch: string,
  done: (submit: SubmitOutcome, detail?: string) => SubmittedDelta,
): Promise<SubmittedDelta> {
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  const push = await execFileChecked("git", ["push", "--quiet", "origin", refspec], {
    cwd: dir,
    env: pickEnv(ctx, PUSH_ENV_KEYS),
    allowFailure: true,
  }).catch((error: unknown) => ({ code: null, stdout: "", stderr: errorMessage(error) }));
  if (push.code !== 0) return done(outcome(method, "failed", branch), push.stderr.trim());
  return done(outcome(method, "pushed", branch));
}

export interface ItemWorker {
  ctx: SessionCliContext;
  /** The folder the agent edits; resolved per item ({@link projectRoot}) when absent. */
  dir?: string;
  method: LocalSubmitMethod;
  /** Asks the human; null on EOF. Used when `method` is `ask` and, in manual mode, per item. */
  ask(question: string): Promise<string | null>;
  /**
   * Manual control: the human confirms each item before it runs. Absent or false is auto, where
   * master-driven items run without a skep prompt and only the submit policy may still ask.
   */
  confirmItems?: boolean;
  /** How the agent runs. Absent fails the item: there is no dry fallback (SESSION-UX §3.2). */
  agent?: AgentSetup;
  /** Receives state changes; a PTY run is bracketed by `suspend()`/`resume()`. */
  view?: JoinView;
  /** Replaces {@link ask} when set (`--ui`): the view asks the human. */
  chooseSubmit?: JoinView["chooseSubmit"];
  /** Peers shown in the view model (this device once joined). */
  peers?: JoinViewModel["peers"];
  /** Serializes PTY runs: one agent owns the terminal at a time. */
  terminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Runs whole items one at a time. Items share one working tree, so two agents at once would
   * interleave edits and each delta would contain the other's files.
   */
  serial?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Aborted when the join is closing; stops a running PTY or herdr wait. */
  signal?: AbortSignal;
  onAgentState?(itemId: string, state: JoinAgentState): void;
  /** The joined session, recorded with each item's delta so undo/submit name the run (R2). */
  sessionId?: () => string | undefined;
  /** Measures item duration (default: the system clock). */
  clock?: Clock;
}

/** A one-at-a-time queue: each call starts after the previous one settled. */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
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

/**
 * Manual mode's per-item question. It waits for the terminal like a PTY run, so it never asks
 * while an agent owns the screen. Empty means yes; no answer (EOF, `/clean`) means no.
 */
async function confirmItem(worker: ItemWorker, item: PlanItem): Promise<boolean> {
  const exclusive = worker.terminal ?? ((fn) => fn());
  // A join that is closing asks nothing more: questions queued behind the current one are
  // dropped instead of surfacing after the session ended.
  const answer = await exclusive(async () =>
    worker.signal?.aborted === true
      ? null
      : worker.ask(`Run item ${item.itemId} (${item.repo}): ${item.title}? [Y/n] `),
  );
  if (worker.signal?.aborted === true) return false;
  return answer !== null && /^\s*(y(es)?)?\s*$/i.test(answer);
}

/** The agent's own closing words: its last paragraph, a few lines at most. */
export function agentSummary(tail: string): string {
  const lines = tail.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const start = lines.findLastIndex((line) => line.trim() === "");
  const paragraph = lines.slice(start + 1).slice(-5);
  const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function said(executed: Executed): { said?: string } {
  return executed.said === undefined || executed.said === "" ? {} : { said: executed.said };
}

const DELTA_ASK = "Submit this item? [commit/push/pr/mr/none/skip] ";
const ASK_CHOICES = ["commit", ...DIRECT_METHODS] as const;

/**
 * Everything a sub does for one item. Never throws: a failure is a result with `failed`.
 *
 * A blocked herdr agent's result (`pending`) goes to the master at once, but the agent can still
 * edit the folder once the human answers it. The item keeps its place in the serial queue until
 * that agent settles or the join closes, so the next item never runs beside it (R4).
 */
export async function workItem(worker: ItemWorker, item: PlanItem): Promise<SubResult> {
  const { serial } = worker;
  if (serial === undefined) {
    const { result, hold } = await workItemNow(worker, item);
    void hold.catch(() => undefined);
    return result;
  }
  return new Promise<SubResult>((resolve, reject) => {
    serial(async () => {
      const { result, hold } = await workItemNow(worker, item);
      resolve(result);
      await hold;
    }).catch(reject);
  });
}

async function workItemNow(
  worker: ItemWorker,
  item: PlanItem,
): Promise<{ result: SubResult; hold: Promise<void> }> {
  let hold: Promise<void> = Promise.resolve();
  const result = await workItemRun(worker, item, (settled) => {
    hold = settled;
  });
  return { result, hold };
}

async function workItemRun(
  worker: ItemWorker,
  item: PlanItem,
  holdUntil: (settled: Promise<void>) => void,
): Promise<SubResult> {
  const { ctx } = worker;
  const clock = worker.clock ?? systemClock;
  const started = clock.monotonicMs();
  const redactor = new Redactor();
  // Every summary byte that leaves for the master is control-stripped and redacted (D27).
  const clean = (text: string): string => redactor.redact(dropControlChars(text));
  const cli = worker.agent?.view === "dry" ? "no agent" : (worker.agent?.cli ?? "no agent");
  const wireMethod: SubmitMethod = worker.method === "commit" ? "none" : worker.method;

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
    submit: { policy: wireMethod, ...(submit === undefined ? {} : { outcome: submit }) },
  });
  const report = (state: JoinAgentState, focus?: readonly string[]): void => {
    agentState = state;
    if (focus !== undefined) focusCommand = focus;
    worker.onAgentState?.(item.itemId, agentState);
    worker.view?.update(show());
  };
  /**
   * The summary the master shows (SESSION-UX §2.3): the submit line, a status line, the changed
   * files, then cause and fix for a failure, then the agent's own words.
   */
  const result = (
    fields: Omit<SubResult, "repo" | "summary" | "submit"> & { submit: SubmitOutcome },
    parts: {
      word: string;
      submitLine?: string;
      changed?: string;
      cause?: string;
      fix?: string;
      log?: string | undefined;
      said?: string;
      body?: string;
    },
  ): SubResult => {
    const elapsed = formatDuration(clock.monotonicMs() - started);
    const lines = [
      parts.submitLine ?? submitLine(fields.submit),
      `${parts.word} · ${cli} · ${elapsed}`,
      ...(parts.changed === undefined ? [] : [parts.changed]),
      ...(parts.cause === undefined ? [] : [`cause: ${parts.cause}`]),
      ...(parts.fix === undefined ? [] : [`fix: ${parts.fix}`]),
      ...(parts.log === undefined ? [] : [`full text: ${parts.log}`]),
    ];
    const body = parts.body === undefined ? "" : clean(parts.body).trim();
    const said = parts.said === undefined ? "" : clean(parts.said);
    const text = [...lines.map(clean), ...(said === "" ? [] : [`summary: ${said}`]), body]
      .filter((line) => line !== "")
      .join("\n");
    const final: SubResult = { repo: item.repo, ...fields, summary: clipSummary(text) };
    worker.onAgentState?.(item.itemId, agentState);
    worker.view?.update(show(fields.submit));
    return final;
  };

  const dir = worker.dir ?? (await projectRoot(ctx));
  const deviceHead = async (): Promise<string> => {
    const sha = await git(ctx, ["rev-parse", "HEAD"], dir)
      .then((value) => value.trim())
      .catch(() => UNKNOWN_SHA);
    return ShaSchema.safeParse(sha).success ? sha : UNKNOWN_SHA;
  };
  const branch = await currentBranch(ctx, dir);
  const baseSha = await deviceHead();
  const home = ctx.paths?.home;
  const failLog = async (text: string): Promise<string | undefined> =>
    home === undefined ? undefined : writeLastError(home, text).catch(() => undefined);
  const meta = {
    itemId: item.itemId,
    epoch: item.epoch,
    title: item.title,
    sessionId: worker.sessionId?.() ?? null,
    root: dir,
  };
  const record = (delta: ItemDelta, head: string | null): Promise<DeltaRecord> | null =>
    home === undefined ? null : writeDeltaRecord(home, { ...meta, head }, delta, clock.nowMs());

  // This run replaces any earlier record of the id before anything else happens: an id from an
  // earlier session must never be undone or submitted in this run's name (R2).
  try {
    await record({ files: [], partial: false }, baseSha);
  } catch (error) {
    agentState = "failed";
    const cause = `could not record this run for undo: ${errorMessage(error)}`;
    const fix = "check that the skep home is writable on this device, then send the intent again";
    return result(
      {
        baseSha,
        headSha: baseSha,
        checks: [{ name: "peer", status: "fail" }],
        submit: outcome(wireMethod, "failed", branch),
      },
      { word: "FAILED", cause, fix },
    );
  }

  if (worker.signal?.aborted === true) {
    agentState = "failed";
    return result(
      {
        baseSha,
        headSha: baseSha,
        checks: [{ name: "peer", status: "skip" }],
        submit: outcome(wireMethod, "skipped", branch),
      },
      { word: "skipped", body: "the session closed before this item started; nothing ran" },
    );
  }
  if (worker.confirmItems === true && !(await confirmItem(worker, item))) {
    return result(
      {
        baseSha,
        headSha: baseSha,
        checks: [{ name: "peer", status: "skip" }],
        submit: outcome(wireMethod, "skipped", branch),
      },
      { word: "declined", body: "declined on this device (manual mode); nothing ran" },
    );
  }

  const io = snapshotIo(ctx);
  let before: TreeSnapshot;
  try {
    before = await snapshotTree(dir, io);
  } catch (error) {
    agentState = "failed";
    const cause = `could not read the project folder ${dir}: ${errorMessage(error)}`;
    const fix =
      "check that this folder is readable and git works in it, then send the intent again";
    return result(
      {
        baseSha,
        headSha: baseSha,
        checks: [{ name: "git", status: "fail" }],
        submit: outcome(wireMethod, "failed", branch),
      },
      { word: "FAILED", cause, fix, log: await failLog(`${item.itemId}\n${cause}\nfix: ${fix}`) },
    );
  }

  let executed: Executed;
  try {
    executed = await executeItem(worker, item, dir, report);
  } catch (error) {
    // After an accepted prompt a herdr failure is final: never replayed natively (§11.4).
    executed = {
      status: "failed",
      summary: "",
      cause: `agent ${cli} failed: ${errorMessage(error)}`,
      fix: "read the full text, fix the cause on this device, then send the intent again",
      full: errorMessage(error),
    };
  }
  tail = clean(executed.summary).slice(-MAX_SUMMARY);

  let delta: ItemDelta = { files: [], partial: false };
  let deltaProblem = "";
  try {
    delta = await computeDelta(before, io);
  } catch (error) {
    deltaProblem = `could not compare the files after the run: ${errorMessage(error)}`;
  }
  const headSha = await deviceHead();
  let recorded: DeltaRecord | null = null;
  if (delta.files.length > 0) {
    try {
      recorded = await record(delta, headSha);
    } catch (error) {
      deltaProblem = `could not record the changes for undo: ${errorMessage(error)}`;
    }
  }
  const changed =
    deltaProblem === "" ? changedLine(delta) : `${changedLine(delta)}; ${deltaProblem}`;
  const paths = delta.files.map((file) => file.path);

  if (executed.status === "dry") {
    // Never success-shaped: a failed check, so the master counts it failed (SESSION-UX §3.2).
    agentState = "done";
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "agent", status: "fail" }],
        submit: outcome(wireMethod, "skipped", branch),
      },
      { word: "DRY RUN", body: executed.summary },
    );
  }
  if (executed.status === "blocked") {
    // Nothing is checked or submitted; the edits stay in the folder (D29).
    agentState = "blocked";
    const { settle } = executed;
    if (settle !== undefined) holdUntil(settleBlocked(settle));
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "agent", status: "skip" }],
        submit: outcome(wireMethod, "pending", branch),
      },
      { word: "blocked", changed, ...said(executed), body: executed.summary },
    );
  }
  if (executed.status === "failed") {
    agentState = "failed";
    const log = await failLog(
      `${item.itemId} (epoch ${item.epoch}) in ${dir}: ${item.title}\n` +
        `cause: ${executed.cause}\nfix: ${executed.fix}\n${changed}\n\n${executed.full}`,
    );
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "agent", status: "fail" }],
        submit: outcome(wireMethod, "failed", branch),
      },
      {
        word: "FAILED",
        changed,
        cause: executed.cause,
        fix: executed.fix,
        ...(log === undefined ? {} : { log }),
        ...said(executed),
        body: executed.summary,
      },
    );
  }
  agentState = "done";
  if (delta.files.length === 0) {
    return result(
      {
        baseSha,
        headSha,
        checks: [{ name: "none", status: "skip" }],
        submit: outcome(wireMethod, "skipped", branch),
      },
      { word: "done", changed, ...said(executed), body: executed.summary },
    );
  }

  // Checks are information now: they run where the agent worked, after it (SESSION-UX §3.3).
  const checks = await runChecks(ctx, dir).catch((): CheckStatus[] => [
    { name: "checks-file", status: "fail" },
  ]);
  let method: DeltaMethod;
  if (worker.method === "ask") {
    let chosen: DeltaMethod | undefined;
    if (worker.chooseSubmit !== undefined) {
      const picked = await worker.chooseSubmit(show());
      chosen = ASK_CHOICES.find((value) => value === picked);
    } else {
      ctx.stderr.write(`item ${item.itemId} ${changed}\n`);
      const answer = (await worker.ask(DELTA_ASK))?.trim() ?? "";
      chosen = ASK_CHOICES.find((value) => value === answer.toLowerCase());
    }
    if (chosen === undefined) {
      return result(
        { baseSha, headSha, checks, submit: outcome("ask", "skipped", branch) },
        { word: "done", changed, ...said(executed), body: executed.summary },
      );
    }
    method = chosen;
  } else {
    method = worker.method;
  }
  if (method !== "none" && checks.some((check) => check.status === "fail")) {
    // Failing code is never committed or pushed; the edits stay in the folder.
    return result(
      {
        baseSha,
        headSha,
        checks,
        submit: outcome(method === "commit" ? "none" : method, "skipped", branch),
      },
      {
        word: "done",
        changed,
        ...said(executed),
        body: `checks failed; not submitted\n${executed.summary}`,
      },
    );
  }
  const submitted = await submitDelta(ctx, {
    dir,
    itemId: item.itemId,
    method,
    paths,
    title: item.title,
    body: clean(executed.said ?? ""),
    ...(recorded === null ? {} : { record: recorded }),
  });
  if (submitted.submit.state === "failed") {
    // The agent's work is in the folder; only the submit failed. Say why and what to do (R6).
    const cause = `submit ${method} failed: ${submitted.detail || "no detail"}`;
    const fix =
      `the edits stay in ${dir}; fix the cause, then run: skep session submit ` +
      `${item.itemId} --epoch ${item.epoch} --method ${method}`;
    return result(
      { baseSha, headSha: await deviceHead(), checks, submit: submitted.submit },
      {
        word: "FAILED",
        submitLine: submitted.line,
        changed,
        cause,
        fix,
        log: await failLog(`${item.itemId} (epoch ${item.epoch}) in ${dir}\n${cause}\nfix: ${fix}`),
        ...said(executed),
        body: executed.summary,
      },
    );
  }
  const detail = submitted.detail === "" ? "" : `${submitted.detail}\n`;
  return result(
    { baseSha, headSha: await deviceHead(), checks, submit: submitted.submit },
    {
      word: "done",
      submitLine: submitted.line,
      changed,
      ...said(executed),
      body: detail + executed.summary,
    },
  );

  /**
   * Waits for a blocked agent to finish in its pane, then records everything it changed since
   * the run began, so undo and a later submit cover the whole run.
   */
  async function settleBlocked(settle: () => Promise<string>): Promise<void> {
    let state: string;
    try {
      state = await settle();
    } catch (error) {
      // Closing the join aborts the watch (R4). Skip further home/folder writes: callers may
      // already be tearing the sandbox or project session state down.
      if (worker.signal?.aborted === true) return;
      state = `lost (${errorMessage(error)})`;
    }
    if (worker.signal?.aborted === true) return;
    let changedNow: string;
    try {
      const after = await computeDelta(before, io);
      // Always replaced, even when empty: an agent that reverted its interim edits leaves
      // nothing for undo or submit to act on (R11).
      await record(after, await deviceHead());
      changedNow = changedLine(after);
    } catch (error) {
      changedNow = `could not record the changes: ${errorMessage(error)}`;
    }
    ctx.stderr.write(
      `item ${item.itemId}: the agent ${state}; ${changedNow}\n` +
        `submit it with: skep session submit ${item.itemId} --epoch ${item.epoch} --method <commit|push|pr|mr>\n`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Commands.

export interface StartOptions {
  listen?: string;
  /** `host:port` peers dial, when it differs from the bind address (NAT, relay, public IP). */
  advertise?: string;
  device?: string;
  repo?: string;
  yes?: boolean;
}

export interface JoinOptions {
  code: string;
  host?: string;
  device?: string;
  repo?: string;
  role: string;
  submit?: LocalSubmitMethod;
  /** The agent CLI (`claude`, `codex`, `pi`); legacy view names are mapped by the callers. */
  agent?: AgentCli;
  /** How items run: native (default), pty, herdr, or dry (test/demo only, reports failed). */
  view?: AgentView;
  ui?: boolean;
  /** Opt out of auto control: confirm each master-driven item before it runs. */
  manual?: boolean;
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
    .option(
      "--listen <host:port>",
      `address to bind (default: LAN IPv4, first available port ${DEFAULT_PORT}–${LAST_AUTO_PORT})`,
    )
    .option(
      "--advertise <host:port>",
      "address peers dial, printed in the join line (default: the --listen address)",
    )
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
        "how finished items are submitted (default: device policy, else none)",
      ).choices(SUBMIT_METHODS),
    )
    .option(
      "--agent <cli>",
      "agent CLI: claude, codex or pi (default: SKEP_AGENT_CLI, AGENT.md if present, else PATH)",
    )
    .addOption(
      new Option(
        "--view <view>",
        "how the agent runs: native (default), pty, herdr; dry runs nothing and reports failed",
      ).choices(AGENT_VIEWS),
    )
    .addOption(
      new Option("--role-dir <dir>", "ignored (AGENT.md is no longer required)").hideHelp(),
    )
    .option("--ui", "use the full-screen view")
    .option("--manual", "confirm each item before it runs (default: auto, no skep prompt)")
    .action(async (opts: Omit<JoinOptions, "agent"> & { agent?: string; roleDir?: string }) => {
      const { agent, roleDir, ...rest } = opts;
      const choice = parseAgentFlag(agent);
      if (roleDir !== undefined) {
        sctx.stderr.write("skep: --role-dir is ignored; AGENT.md is no longer required\n");
      }
      await joinCommand(sctx, {
        ...rest,
        ...(choice.cli === undefined ? {} : { agent: choice.cli }),
      });
    });

  session
    .command("submit")
    .description("Commit, push or open a PR/MR for a finished item's recorded changes")
    .argument("<itemId>", "the item id, e.g. I-1")
    .addOption(
      new Option("--method <method>", "commit, push, pr, mr, none or skip")
        .choices(SUBMIT_COMMAND_METHODS)
        .makeOptionMandatory(),
    )
    .option("--epoch <n>", "the item's epoch", "1")
    .action(async (itemId: string, opts: SubmitOptions) => {
      await submitCommand(sctx, itemId, opts);
    });

  session
    .command("undo")
    .description("Put the files a session item changed back to their content from before it")
    .argument("<itemId>", "the item id, e.g. I-1")
    .option("--force", "also overwrite files that changed again after the item")
    .action(async (itemId: string, opts: { force?: boolean }) => {
      await undoCommand(sctx, itemId, opts);
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

// ---------------------------------------------------------------------------------------------
// Session flows: the command bodies without Commander, signals or blocking, so the unified shell
// (`src/cli/shell/run.ts`) drives the same code paths as `skep session start|join|intent|status`.

export type JoinRequest = Parameters<MasterOptions["acceptJoin"]>[0];

export interface StartMasterFlowOptions extends StartOptions {
  /** Asked for every join unless `yes` is set. */
  acceptJoin(request: JoinRequest): Promise<boolean>;
  /** A rotated join code, after the flow resolved; the first one is on the returned flow. */
  onJoinCode?(joinCode: string, expiresAtMs: number): void;
  /** Protocol events of the master (peer joined, intent planned, ...). */
  onEvent?(event: { kind: string; message: string }): void;
}

export interface MasterFlow {
  readonly handle: MasterHandle;
  /** The bind address. */
  readonly listen: string;
  /** The address peers dial: `--advertise`, else {@link listen}. */
  readonly advertise: string;
  readonly repo: string;
  readonly device: string;
  /** Formatted `NNNN-NNNN-NNNN`, current as of the last rotation. */
  readonly joinCode: string | null;
  readonly joinCodeExpiresAtMs: number | null;
  /** Settles once the master closed and this flow's `session.json` was removed. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

async function bindMaster(
  api: SessionApi,
  options: MasterOptions,
  target: HostPort,
  autoListen: boolean,
): Promise<MasterHandle> {
  const lastPort = autoListen ? LAST_AUTO_PORT : target.port;
  let port = target.port;
  while (true) {
    const listen = { host: target.host, port };
    try {
      // Bind directly: a separate availability probe would race other project starts.
      return await api.startMaster({ ...options, listen });
    } catch (error) {
      if (
        !(error instanceof ListenAddressError) ||
        !(error.cause instanceof Error) ||
        !("code" in error.cause) ||
        error.cause.code !== "EADDRINUSE"
      ) {
        throw error;
      }
      if (port < lastPort) {
        port++;
        continue;
      }
      const problem = autoListen
        ? `no available session listen port on ${target.host} in ${target.port}–${lastPort}`
        : `the session listen address ${formatHostPort(listen)} is already in use`;
      throw new CliError(
        "session_port_in_use",
        `${problem}; choose an unused port with --listen <host:unused-port> ` +
          "(/start in the skep shell, or skep session start in a terminal). " +
          "Different projects use separate homes and available ports automatically when overrides are omitted",
      );
    }
  }
}

/**
 * Binds a master and publishes `session.json`. Resolves once the master listens; the caller owns
 * how long it runs (`closed`) and how it stops (`close`).
 */
export async function startMasterFlow(
  ctx: SessionCliContext,
  opts: StartMasterFlowOptions,
): Promise<MasterFlow> {
  let target: HostPort;
  if (opts.listen !== undefined) {
    target = concreteHostPort("--listen", opts.listen);
  } else {
    const ifaces = (ctx.networkInterfaces ?? os.networkInterfaces)();
    target = { host: pickListenHost(ifaces), port: DEFAULT_PORT };
  }
  // A wildcard is no address a peer can dial, so it is refused here exactly as for a bind.
  const advertised =
    opts.advertise === undefined
      ? null
      : formatHostPort(concreteHostPort("--advertise", opts.advertise));
  const device = validDevice(opts.device);
  const repo = validRepo(opts.repo ?? (await defaultRepo(ctx)));

  const file = sessionFilePath(ctx);
  await refuseIfRunning(file);

  const api = await loadSessionApi(ctx);
  const token = Buffer.from(cryptoRandom.bytes(16)).toString("hex");

  let started = false;
  let code: string | null = null;
  let codeExpiresAtMs: number | null = null;
  const onJoinCode = (info: { code: string; expiresAtMs: number }): void => {
    code = formatJoinCode(info.code);
    codeExpiresAtMs = info.expiresAtMs;
    // The initial code may arrive before startMaster resolves; it is reported with the flow.
    if (started) opts.onJoinCode?.(code, codeExpiresAtMs);
  };

  const handle = await bindMaster(
    api,
    {
      repo,
      device,
      controlToken: token,
      clock: systemClock,
      random: cryptoRandom,
      onJoinCode,
      acceptJoin: (request) =>
        opts.yes === true ? Promise.resolve(true) : opts.acceptJoin(request),
      ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
    },
    target,
    opts.listen === undefined,
  );
  const closed = handle.closed.then(
    () => removeOwnSessionFile(file, token),
    async (error: unknown) => {
      await removeOwnSessionFile(file, token);
      throw error;
    },
  );
  let listen: string;
  try {
    listen = listenOf(handle);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, `${JSON.stringify({ listen, token })}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    await handle.close();
    await closed.catch(() => undefined);
    throw error;
  }
  started = true;
  return {
    handle,
    listen,
    advertise: advertised ?? listen,
    repo,
    device,
    get joinCode() {
      return code;
    },
    get joinCodeExpiresAtMs() {
      return codeExpiresAtMs;
    },
    closed,
    close: async () => {
      await handle.close();
      await closed;
    },
  };
}

async function startCommand(ctx: SessionCliContext, opts: StartOptions): Promise<void> {
  const output = ctx.output();
  let reader: LineReader | undefined;
  let prompts: Promise<unknown> = Promise.resolve();
  const acceptJoin = (request: JoinRequest): Promise<boolean> => {
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

  let flow: MasterFlow;
  try {
    flow = await startMasterFlow(ctx, {
      ...opts,
      acceptJoin,
      onJoinCode: (joinCode, expiresAtMs) =>
        output.result(
          { event: "join-code", joinCode, joinCodeExpiresAtMs: expiresAtMs },
          () =>
            `join code: ${joinCode}${expiryText(expiresAtMs)}\n` +
            `${formatJoinPaste({ host: flow.advertise, code: joinCode, repo: flow.repo })}\n`,
        ),
    });
  } catch (error) {
    reader?.close();
    throw error;
  }

  const stop = (): void => {
    // A failed close surfaces below through `flow.closed`.
    flow.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { listen, advertise, repo, device, joinCode, joinCodeExpiresAtMs } = flow;
    output.result(
      { event: "started", listen, advertise, repo, device, joinCode, joinCodeExpiresAtMs },
      () => startedText(flow),
    );
    await flow.closed;
    output.result({ event: "closed" }, () => "session closed\n");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    reader?.close();
  }
}

/** The human start banner, shared by `skep session start` and the shell's `/start`. */
export function startedText(flow: MasterFlow): string {
  const { listen, advertise, repo, joinCode, joinCodeExpiresAtMs } = flow;
  const dial = advertise === listen ? "" : `peers dial ${advertise}\n`;
  const hint = joinCode === null ? "" : `${joinHint({ host: advertise, code: joinCode, repo })}\n`;
  return (
    `session master listening on ${listen} (repo ${repo})\n${dial}` +
    `join code: ${joinCode ?? "none"}${expiryText(joinCodeExpiresAtMs)}\n${hint}`
  );
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
    `a session master is already running at ${existing.listen} (${file})\n` +
      "Only one session per home can run. Different projects use separate homes and available " +
      "ports automatically. If SKEP_HOME or --home makes projects share this home, omit the " +
      "override; for another session in this project, launch skep --home <separate-dir>, " +
      "then /start (or skep --home <separate-dir> session start in a terminal)",
  );
}

export type StaleSessionFile =
  | { kind: "none" }
  | { kind: "live"; listen: string }
  | { kind: "removed"; listen: string | null }
  /** Another master published itself while the stale file was being removed; it was kept. */
  | { kind: "replaced" };

export interface ClearStaleOptions {
  timeoutMs?: number;
  /** Test seam: runs after the probe decided the file is stale, before it is moved aside. */
  beforeRemove?(): Promise<void>;
  /** Test seam: runs after the file was moved aside, before its content is checked. */
  afterMoveAside?(): Promise<void>;
  /** Test seam: replaces the hard link that restores a moved-aside file. */
  link?(existing: string, created: string): Promise<void>;
}

/**
 * Removes `session.json` when no master answers behind it (its process is gone, or the file is
 * corrupt). A master that answers is left alone: clearing this device never stops another
 * process. Only the exact bytes that were judged stale are removed (see `removeSessionFileIf`),
 * so a master that publishes itself meanwhile keeps its file.
 */
export async function clearStaleSessionFile(
  ctx: CliContext,
  clock: Clock,
  options: ClearStaleOptions = {},
): Promise<StaleSessionFile> {
  const file = sessionFilePath(ctx);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw error;
  }
  let existing: SessionFile | null = null;
  try {
    existing = parseSessionFile(file, raw);
  } catch (error) {
    // A corrupt file cannot point at a live master (see `refuseIfRunning`).
    if (!(error instanceof CliError && error.code === "bad_session_file")) throw error;
  }
  const target = existing === null ? null : parseHostPort(existing.listen);
  if (existing !== null && target !== null) {
    try {
      await controlRequest(
        target,
        { type: "control", v: 1, token: existing.token, op: "status" },
        clock,
        options.timeoutMs ?? PROBE_TIMEOUT_MS,
      );
      return { kind: "live", listen: existing.listen };
    } catch (error) {
      // Only a request that never left proves nobody listens there. A reply that was malformed,
      // late or cut off still came from a live process: keep its file.
      if (!(error instanceof ControlConnectionError) || error.requestSent) {
        return { kind: "live", listen: existing.listen };
      }
    }
  }
  await options.beforeRemove?.();
  const outcome = await removeSessionFileIf(file, (current) => current === raw, options);
  if (outcome === "absent") return { kind: "none" };
  if (outcome === "kept") return { kind: "replaced" };
  return { kind: "removed", listen: existing?.listen ?? null };
}

/** Remove the control file only if it is still ours. */
async function removeOwnSessionFile(file: string, token: string): Promise<void> {
  await removeSessionFileIf(file, (raw) => {
    try {
      return parseSessionFile(file, raw).token === token;
    } catch {
      // Not parseable means not ours: never remove what this master did not write.
      return false;
    }
  });
}

/**
 * Removes `file` only while it holds what `matches` accepts. A read followed by an unlink would
 * delete a publication that lands in between, so the file is renamed aside first (atomic: what
 * is moved is exactly what gets checked). A file that does not match is put back without ever
 * replacing a newer publication (see `restoreSessionFile`). Masters publish with an atomic
 * rename, so the file is never seen half-written.
 */
async function removeSessionFileIf(
  file: string,
  matches: (raw: string) => boolean,
  seams: Pick<ClearStaleOptions, "afterMoveAside" | "link"> = {},
): Promise<"removed" | "kept" | "absent"> {
  const aside = `${file}.${Buffer.from(cryptoRandom.bytes(6)).toString("hex")}.removing`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  await seams.afterMoveAside?.();
  let raw: string;
  try {
    raw = await readFile(aside, "utf8");
  } catch (error) {
    await restoreSessionFile(aside, file, seams.link ?? link);
    throw error;
  }
  if (matches(raw)) {
    await rm(aside, { force: true });
    return "removed";
  }
  await restoreSessionFile(aside, file, seams.link ?? link);
  return "kept";
}

/**
 * Puts a moved-aside file back with a hard link, which fails with `EEXIST` instead of replacing
 * a publication that landed meanwhile; that newer one wins, as it would have by overwriting.
 * Node has no other create-if-absent rename, and a `rename` onto the path would silently replace
 * a newer master's file, so when linking is impossible the moved file is retained beside
 * `session.json` and the caller is told where it is.
 */
async function restoreSessionFile(
  aside: string,
  file: string,
  linkFile: (existing: string, created: string) => Promise<void>,
): Promise<void> {
  try {
    await linkFile(aside, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A newer publication exists: the moved-aside one is older and is dropped, never restored.
    if (code !== "EEXIST" && !(await exists(file))) {
      throw new CliError(
        "session_file_retained",
        `could not put ${file} back (${code ?? errorMessage(error)}); it is kept at ${aside} — ` +
          `rename it to ${path.basename(file)} if its master still runs`,
      );
    }
  }
  await rm(aside, { force: true });
}

/**
 * How much a joined device asks its human. `auto` (the default): master-driven items run without
 * a skep prompt; only an explicit `ask` submit policy may still ask. `manual`: each item is confirmed first. Neither
 * touches the agent CLI's own approval UI (D29).
 */
export type JoinControl = "auto" | "manual";

/** The join line naming the agent and where it works (SESSION-UX §2). */
export function agentLine(agent: ResolvedAgent | null, view: AgentView, dir: string): string {
  if (agent === null) {
    return `agent: none · mode: DRY RUN (--view dry): items report failed and nothing changes`;
  }
  const how = view === "native" ? "" : ` (${view} view)`;
  return (
    `agent: ${agent.cli} (${agentSourceText(agent.source)})${how} · ` +
    `mode: edits this folder directly (${dir})`
  );
}

/**
 * One line per finished item for the peer's own scrollback: the status, the changed files, and
 * for a failure the cause and fix (the summary's labelled lines).
 */
export function itemHeadline(itemId: string, result: SubResult): string {
  const lines = result.summary.split("\n");
  const status = lines[1] ?? "";
  const keep = lines
    .slice(2, 8)
    .filter((line) => /^(changed |no changes|cause: |fix: |full text: )/.test(line));
  return [`${itemId} ${status}`, ...keep.map((line) => `  ${line}`)].join("\n");
}

/** The join line's note on what this device will still ask. */
export function controlText(control: JoinControl, method: LocalSubmitMethod): string {
  const submit =
    method === "ask" ? "submit: ask after each item that changed the repo" : `submit: ${method}`;
  return control === "auto"
    ? `auto: master drives work; ${submit}`
    : `manual: you confirm each item before it runs; ${submit}`;
}

export interface JoinFlowOptions extends Omit<JoinOptions, "ui"> {
  /** This device's agent CLI chosen with `/agent`; `--agent` (`agent`) still wins. */
  cli?: AgentCli;
}

export interface JoinFlowIo {
  /** One join event: machine data and its human line (with trailing newline). */
  say(data: unknown, human: () => string): void;
  /** A question for this device's human; null means no answer (defer). */
  ask(question: string): Promise<string | null>;
  warn(message: string): void;
  /** Opened once the options validated, so a bad flag never flashes a screen. */
  createView(): JoinView;
  /** The view answers the "ask" submit policy (`JoinView.chooseSubmit`) instead of `ask`. */
  viewChoosesSubmit?: boolean;
}

export interface JoinFlow {
  readonly handle: SubHandle;
  /** `host:port` of the master. */
  readonly target: string;
  readonly device: string;
  /** The repo this device joined with (`--repo`, else the git toplevel's basename). */
  readonly repo: string;
  readonly role: string;
  /** `auto` unless the human joined with `--manual`. */
  readonly control: JoinControl;
  /** The agent resolved at join; null only for `--view dry`. */
  readonly agent: ResolvedAgent | null;
  readonly view: AgentView;
  /** The folder items edit directly. */
  readonly dir: string;
  /** Settles once the channel closed and running items were aborted. */
  readonly closed: Promise<{ reason: string }>;
  /** Abort running items and leave the session. */
  close(): Promise<void>;
}

/**
 * Joins a master and works its items in the background. Resolves once joined; the caller owns
 * how long it runs (`closed`) and how it stops (`close`).
 */
export async function joinSessionFlow(
  ctx: SessionCliContext,
  opts: JoinFlowOptions,
  io: JoinFlowIo,
): Promise<JoinFlow> {
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
  const { say, ask, warn } = io;
  const view = selectAgentView(opts.view, ctx.env);
  const dir = await projectRoot(ctx);
  // Resolved before connecting: a device without an agent never joins (SESSION-UX §3.2).
  const resolved =
    view === "dry"
      ? null
      : await resolveAgentCli({
          ...(opts.agent === undefined ? {} : { flag: opts.agent }),
          ...(opts.cli === undefined ? {} : { setting: opts.cli }),
          deviceToml: paths.deviceToml,
          env: ctx.env,
          dir,
          warn,
        });
  const agent: AgentSetup = {
    view,
    // Dry never starts a CLI; the name only labels the view model.
    cli: resolved?.cli ?? "claude",
    runtime: ctx.agentRuntime ?? loadAgentRuntime,
    journal: path.join(paths.home, "session", "transcripts"),
    notify: ctx.notify ?? (await deviceNotifier(paths.deviceToml, warn)),
  };
  const api = await loadSessionApi(ctx);
  // A human override on the command line wins over this device's file policy.
  const method = opts.submit ?? (await loadSubmitPolicy(paths.deviceToml, warn)).method;
  const control: JoinControl = opts.manual === true ? "manual" : "auto";

  const joinView = io.createView();
  const abort = new AbortController();
  let subHandle: SubHandle | undefined;
  const worker: ItemWorker = {
    ctx,
    dir,
    method,
    ask,
    ...(control === "manual" ? { confirmItems: true } : {}),
    agent,
    view: joinView,
    ...(io.viewChoosesSubmit === true
      ? { chooseSubmit: (model: JoinViewModel) => joinView.chooseSubmit(model) }
      : {}),
    peers: [],
    terminal: serialQueue(),
    serial: serialQueue(),
    signal: abort.signal,
    onAgentState: (id, state) => subHandle?.reportAgent?.(id, state),
    sessionId: () => subHandle?.sessionId,
  };

  const roster = new Map<string, JoinViewModel["peers"][number]>();
  const phases = new Map<string, PeerProgress["phase"]>();
  let selfId: string | undefined;
  const updatePeers = (): void => {
    worker.peers = [...roster.values()].sort((left, right) => {
      if (left.peerId === selfId) return -1;
      if (right.peerId === selfId) return 1;
      const numberOf = (id: string): number => Number(/^peer-(\d+)$/.exec(id)?.[1] ?? Infinity);
      return (
        numberOf(left.peerId) - numberOf(right.peerId) || left.peerId.localeCompare(right.peerId)
      );
    });
    joinView.update({
      peers: worker.peers,
      item: null,
      agent: null,
      tail: "",
      submit: { policy: method === "commit" ? "none" : method },
    });
  };
  const onProgress: NonNullable<SubOptions["onProgress"]> = (progress) => {
    const { peerId, phase } = progress;
    if (progress.self) selfId = peerId;
    if (phase === "left") {
      roster.delete(peerId);
    } else {
      roster.set(peerId, {
        peerId,
        device: progress.self ? device : progress.device,
        role: progress.self ? role : (progress.role ?? "-"),
        state: phase,
        progress: {
          phase,
          done: progress.done,
          total: progress.total,
          failed: progress.failed,
          percent: progress.percent,
          summary: progress.summary,
        },
      });
    }
    updatePeers();
    if (phases.get(peerId) !== phase) {
      phases.set(peerId, phase);
      say(
        { event: "peer-progress", ...progress },
        () =>
          `peer ${progress.device} ${phase} ${progress.done}/${progress.total} (${progress.percent}%)\n`,
      );
    }
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
      onProgress,
      // A sub that hangs up on purpose (a failed describe/datalist callback) says so here;
      // otherwise the human only sees the close reason.
      onEvent: ({ kind, message }) => {
        if (kind !== "error") return;
        say({ event: "session-error", message }, () => `session: ${message}\n`);
      },
      describe: async () => {
        // --repo is a routing label, not a checkout path. Missing local HEAD would otherwise
        // trigger callback_error (docs/plans/tui-session-reliability.md, Bug 4).
        let head: string;
        try {
          head = ShaSchema.parse((await git(ctx, ["rev-parse", "HEAD"])).trim());
        } catch (error) {
          head = UNKNOWN_SHA;
          warn(
            `cannot read this directory's Git HEAD; reporting an unknown head for ${repo}. ` +
              `Join from a Git checkout with a commit to run work (${errorMessage(error)})`,
          );
        }
        return { repo, role, head };
      },
      collectDatalist: async () => {
        let listed: string;
        try {
          listed = await git(ctx, ["ls-files", "-z"]);
        } catch (error) {
          warn(
            `cannot list this directory's tracked files; sending an empty datalist for ${repo} ` +
              `(${errorMessage(error)})`,
          );
          return [];
        }
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
          () => `${itemHeadline(item.itemId, result)}\n`,
        );
        return result;
      },
    });
    subHandle = handle;
  } catch (error) {
    joinView.close();
    throw error;
  }

  const closed = handle.closed.finally(() => {
    abort.abort();
    joinView.close();
  });
  const at = formatHostPort(target);
  try {
    showFingerprint(handle.fingerprint);
    const { sessionId, peerId } = handle;
    selfId = peerId;
    if (!roster.has(peerId)) roster.set(peerId, { peerId, device, role, state: "joined" });
    updatePeers();
    const agentData =
      resolved === null ? null : { cli: resolved.cli, source: resolved.source, view };
    say(
      {
        event: "joined",
        sessionId,
        peerId,
        target: at,
        control,
        submit: method,
        agent: agentData,
        dir,
      },
      () =>
        `joined session ${sessionId} at ${at} as ${peerId} (${controlText(control, method)})\n` +
        `${agentLine(resolved, view, dir)}\n`,
    );
  } catch (error) {
    abort.abort();
    await handle.close();
    await closed.catch(() => undefined);
    throw error;
  }
  return {
    handle,
    target: at,
    device,
    repo,
    role,
    control,
    agent: resolved,
    view,
    dir,
    closed,
    close: async () => {
      abort.abort();
      await handle.close();
      await closed;
    },
  };
}

async function joinCommand(ctx: SessionCliContext, opts: JoinOptions): Promise<void> {
  const ui = opts.ui === true;
  if (ui && joinViewFactory === null) {
    throw new CliError("ui_unavailable", "the full-screen view is not available in this build");
  }
  if (ui && opts.manual === true) {
    // The full-screen view only answers the submit question; a per-item prompt would fight it.
    throw new CliError("usage", "--manual cannot be combined with --ui yet", EXIT.usage);
  }
  const output = ctx.output();
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
  const { ui: _ui, ...flowOptions } = opts;
  let flow: JoinFlow;
  try {
    flow = await joinSessionFlow(ctx, flowOptions, {
      // The full-screen view owns the terminal; event lines then go only to `--machine` output.
      say: (data, human) => output.result(data, ui ? () => "" : human),
      ask,
      warn: (message) => ctx.stderr.write(`skep: ${message}\n`),
      createView: () =>
        ui && joinViewFactory !== null
          ? joinViewFactory({
              stdin: (ctx.stdin ?? process.stdin) as NodeJS.ReadStream,
              stdout: process.stdout,
            })
          : new LineJoinView(ctx.stderr, ask, {
              pause: () => reader?.pause(),
              resume: () => reader?.resume(),
            }),
      viewChoosesSubmit: ui,
    });
  } catch (error) {
    reader?.close();
    throw error;
  }

  const stop = (): void => {
    // A failed close surfaces below through `flow.closed`.
    flow.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await flow.closed;
    output.result({ event: "closed" }, ui ? () => "" : () => "session closed\n");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    reader?.close();
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

  async chooseSubmit(): Promise<"commit" | "pr" | "mr" | "push" | "none" | null> {
    const answer = (await this.ask(DELTA_ASK))?.trim() ?? "";
    return ASK_CHOICES.find((value) => value === answer.toLowerCase()) ?? null;
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
 * The "decide after the task" path: applies a submit method to an item's recorded changes in
 * this project (SESSION-UX §3.3). The master already acked the result, so this never talks to
 * it. A branch left by skep ≤ 0.1.10 is named, never touched or deleted.
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
  if (ctx.paths === undefined) throw new Error("skep home is not resolved");
  const record = await readDeltaRecord(ctx.paths.home, itemId).catch((error: unknown) => {
    throw new CliError("bad_delta", errorMessage(error));
  });
  if (record === null || record.epoch !== epoch) {
    const dir = await projectRoot(ctx);
    const legacy = legacySessionBranch(itemId, epoch);
    const found = await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${legacy}`], dir)
      .then(() => true)
      .catch(() => false);
    if (found) {
      throw new CliError(
        "legacy_branch",
        `${legacy} is a legacy branch from skep 0.1.x; skep no longer submits it. ` +
          `Use git directly (for example: git push origin ${legacy}). Nothing was changed or deleted`,
      );
    }
    throw new CliError(
      "no_delta",
      `no recorded changes for ${itemId} (epoch ${epoch}) in this project; ` +
        "run this in the folder the item ran in",
    );
  }
  if (record.undoneAtMs !== undefined) {
    throw new CliError("undone", `${runLabel(record)} was undone; there is nothing to submit`);
  }
  if (record.files.length === 0) {
    throw new CliError(
      "no_delta",
      `the latest run of ${runLabel(record)} changed no files; there is nothing to submit. ` +
        `Earlier runs of ${itemId} are not submitted by skep; use git for those`,
    );
  }
  const paths = record.files.map((file) => file.path);
  let submitted: SubmittedDelta;
  if (opts.method === "skip") {
    const branch = await currentBranch(ctx, record.root);
    const submit = outcome("ask", "skipped", branch);
    submitted = { submit, line: submitLine(submit), detail: "" };
  } else {
    submitted = await submitDelta(ctx, {
      dir: record.root,
      itemId,
      method: opts.method,
      paths,
      title: record.title,
      body: "",
      record,
    });
  }
  const { submit, detail, line } = submitted;
  const data = { itemId, epoch, files: paths, submit };
  const human = () => `${line}${detail === "" ? "" : `\n${detail}`}\n`;
  if (submit.state === "failed") {
    ctx
      .output()
      .fail(new CliError("submit_failed", detail || `submitting ${itemId} failed`), data, human);
    ctx.exitCode = EXIT.error;
    return;
  }
  ctx.output().result(data, human);
}

/** Restores the files an item changed (SESSION-UX Phase 3). Refuses rather than overwrite. */
async function undoCommand(
  ctx: SessionCliContext,
  itemId: string,
  opts: { force?: boolean },
): Promise<void> {
  const outcome = await undoItem(ctx, itemId, opts);
  ctx.output().result(
    {
      itemId,
      root: outcome.record.root,
      restored: outcome.restored,
      removed: outcome.removed,
      overwritten: outcome.overwritten,
    },
    () => `${undoText(itemId, outcome)}\n`,
  );
}

/** `skep session undo` and the shell's `/undo`. */
export async function undoItem(
  ctx: SessionCliContext,
  itemId: string,
  opts: { force?: boolean } = {},
): Promise<UndoOutcome> {
  if (!/^I-\d+$/.test(itemId)) {
    throw new CliError("bad_item", `invalid item id: ${JSON.stringify(itemId)}`, EXIT.usage);
  }
  if (ctx.paths === undefined) throw new Error("skep home is not resolved");
  try {
    return await undoDelta(ctx.paths.home, itemId, {
      ...(opts.force === true ? { force: true } : {}),
      nowMs: systemClock.nowMs(),
    });
  } catch (error) {
    if (error instanceof UndoRefusedError) throw new CliError("undo_refused", error.message);
    if (error instanceof DeltaError) throw new CliError("bad_delta", error.message);
    throw error;
  }
}

export function undoText(itemId: string, outcome: UndoOutcome): string {
  const parts = [
    ...(outcome.restored.length === 0 ? [] : [`restored ${outcome.restored.join(", ")}`]),
    ...(outcome.removed.length === 0 ? [] : [`removed ${outcome.removed.join(", ")}`]),
  ];
  const forced =
    outcome.overwritten.length === 0
      ? ""
      : `\noverwrote later edits in ${outcome.overwritten.join(", ")} (--force)`;
  return `undid ${itemId} in ${outcome.record.root}: ${parts.join("; ") || "nothing to restore"}${forced}`;
}

/** An intent request left this device but no usable reply came back (see `controlAt`). */
export const INTENT_OUTCOME_UNKNOWN = "intent_outcome_unknown";

/**
 * A master's control endpoint as published in `session.json`. The token is random per master, so
 * an endpoint also identifies *which* master: a replacement master never accepts an old token.
 */
export interface ControlEndpoint {
  listen: string;
  token: string;
}

/** This device's published master endpoint, or null when no `session.json` exists. */
export async function readControlEndpoint(ctx: CliContext): Promise<ControlEndpoint | null> {
  const local = await readSessionFile(sessionFilePath(ctx));
  return local === null ? null : { listen: local.listen, token: local.token };
}

/** Sends one control op to the master named in `session.json` and returns its `result`. */
async function control(ctx: SessionCliContext, op: Record<string, unknown>): Promise<unknown> {
  const local = await readControlEndpoint(ctx);
  if (local === null) {
    const file = sessionFilePath(ctx);
    throw new CliError("no_session", `no session master is running (${file} not found)`);
  }
  return controlAt(local, op);
}

/** Sends one control op to exactly `endpoint`, without re-reading `session.json`. */
async function controlAt(
  endpoint: ControlEndpoint,
  op: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const target = parseHostPort(endpoint.listen);
  if (target === null) {
    throw new CliError("bad_session_file", `invalid control listen address ${endpoint.listen}`);
  }
  let reply: ControlResult;
  try {
    reply = await controlRequest(
      target,
      { type: "control", v: 1, token: endpoint.token, ...op },
      systemClock,
      timeoutMs ?? (op.op === "intent" ? INTENT_CONTROL_TIMEOUT_MS : CONTROL_TIMEOUT_MS),
    );
  } catch (error) {
    // A lost reply to an intent is not a refusal: the master starts routing before it answers,
    // so the intent may exist. Read-only ops (status) are simply unreachable either way.
    if (error instanceof ControlConnectionError && error.requestSent && op.op === "intent") {
      throw new CliError(
        INTENT_OUTCOME_UNKNOWN,
        `${error.message}; the intent was sent and may have been accepted — ` +
          "check `skep session status` before sending it again",
      );
    }
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
  const result = await submitIntent(ctx, text, repos);
  ctx.output().result(result, () => `${result.intentId}\n`);
}

/** Validates the intent's input; shared by the control path and an in-process master. */
export function checkIntent(text: string, repos: string[] | undefined): void {
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
}

/** Sends an intent to the master named in `session.json`. */
export async function submitIntent(
  ctx: SessionCliContext,
  text: string,
  repos?: string[],
): Promise<{ intentId: string }> {
  checkIntent(text, repos);
  return parseIntentResult(
    await control(ctx, { op: "intent", text, ...(repos === undefined ? {} : { repos }) }),
  );
}

/** Sends an intent to exactly `endpoint` (a master the caller already identified). */
export async function submitIntentAt(
  endpoint: ControlEndpoint,
  text: string,
  repos?: string[],
): Promise<{ intentId: string }> {
  checkIntent(text, repos);
  return parseIntentResult(
    await controlAt(endpoint, { op: "intent", text, ...(repos === undefined ? {} : { repos }) }),
  );
}

function parseIntentResult(result: unknown): { intentId: string } {
  const parsed = IntentResultSchema.safeParse(result);
  if (!parsed.success) {
    // `ok: true` came back, so the master took the intent; only its id is unreadable.
    throw new CliError(
      INTENT_OUTCOME_UNKNOWN,
      `session master accepted the intent but sent a malformed id (${parsed.error.message}); ` +
        "check `skep session status` before sending it again",
    );
  }
  return parsed.data;
}

/** Status of the master named in `session.json`. */
export async function fetchSessionStatus(ctx: SessionCliContext): Promise<SessionStatus> {
  return parseStatus(await control(ctx, { op: "status" }));
}

/** Status of exactly `endpoint`; `timeoutMs` bounds discovery probes. */
export async function fetchSessionStatusAt(
  endpoint: ControlEndpoint,
  timeoutMs?: number,
): Promise<SessionStatus> {
  return parseStatus(await controlAt(endpoint, { op: "status" }, timeoutMs));
}

function parseStatus(result: unknown): SessionStatus {
  const parsed = SessionStatusSchema.safeParse(result);
  if (!parsed.success) throw badReply("status", parsed.error);
  return parsed.data;
}

async function statusCommand(ctx: SessionCliContext): Promise<void> {
  const status = await fetchSessionStatus(ctx);
  ctx.output().result(status, () => renderSessionStatus(status));
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

/**
 * A part of `skep session status`. Item results are their own parts so the shell can wrap them
 * (with the tone of their outcome) instead of cutting them like an info line (R8).
 */
export interface StatusSection {
  text: string;
  kind: "info" | "result" | "failed";
}

export function renderSessionStatus(status: SessionStatus): string {
  return `${sessionStatusSections(status)
    .map((section) => section.text)
    .join("\n")}\n`;
}

export function sessionStatusSections(status: SessionStatus): StatusSection[] {
  const sections: StatusSection[] = [];
  const code = status.joinCode === null ? "none" : formatJoinCode(status.joinCode);
  let lines = [
    `session ${status.sessionId}  listen ${status.listen}  repo ${status.repo}`,
    `join code: ${code}${expiryText(status.joinCodeExpiresAtMs)}`,
    "",
  ];
  const flush = (): void => {
    if (lines.length > 0) sections.push({ text: lines.join("\n"), kind: "info" });
    lines = [];
  };
  if (status.peers.length === 0) {
    lines.push("peers: none");
  } else {
    lines.push("peers:");
    lines.push(
      table([
        ["PEER", "DEVICE", "ADDRESS", "REPO", "HEAD", "ROLE", "PROGRESS"],
        ...status.peers.map((p) => [
          p.peerId,
          p.device,
          p.address,
          p.repo ?? "-",
          p.head === null ? "-" : p.head.slice(0, 12),
          p.role ?? "-",
          p.progress === undefined ? "-" : `${p.progress.phase} ${p.progress.percent}%`,
        ]),
      ]),
    );
  }
  lines.push("");
  if (status.intents.length === 0) {
    lines.push("intents: none");
  } else {
    lines.push("intents:");
    const devices = new Map(status.peers.map((peer) => [peer.peerId, peer.device]));
    for (const intent of status.intents) {
      lines.push(`  ${intent.intentId}  ${intent.state}  ${intent.text}`);
      if (intent.items.length === 0) continue;
      lines.push(`    ${intentRollup(intent.items)}`);
      lines.push(
        table(
          intent.items.map((item) => {
            const verdict = itemVerdict(item);
            return [
              `  ${item.itemId}`,
              verdict === "running" ? item.state : verdict,
              item.repo,
              item.assignee,
              item.result?.submit === undefined
                ? "-"
                : `${item.result.submit.method}:${item.result.submit.state}`,
              item.title,
            ];
          }),
        ),
      );
      // The last result of each item in full, never the event cap: the shell wraps it (§2.1).
      for (const item of intent.items) {
        if (item.result === undefined) continue;
        const where = { device: devices.get(item.assignee) ?? item.assignee, repo: item.repo };
        const verdict = itemVerdict(item);
        const block = itemBlock(item.itemId, where, item.result.summary, verdict, { full: true });
        flush();
        sections.push({
          text: block
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n"),
          kind: verdict === "failed" || verdict === "submit-failed" ? "failed" : "result",
        });
      }
    }
  }
  flush();
  return sections;
}
