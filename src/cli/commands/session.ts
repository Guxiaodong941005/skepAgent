/**
 * `skep session` — the CLI surface of session mode (in-memory master/sub channel on one TCP port).
 *
 * The protocol engine lives in `src/session/` (a separate task). This file only depends on the
 * {@link SessionApi} subset declared below and loads the module dynamically, so the CLI builds and
 * tests without it: tests inject `sessionApi` on the context instead.
 *
 * `intent` and `status` talk to a running master over the plaintext control frame, authenticated
 * by the token in `${SKEP_HOME}/session.json`. The master writes that file after it binds and
 * removes it on clean exit.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { type Command, Option } from "commander";
import { z } from "zod";
import { RepoRefSchema, ShaSchema } from "../../core/schemas/common.js";
import { type Clock, isoUtc, systemClock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import { atomicWrite } from "../../util/fs.js";
import { cryptoRandom, type RandomSource } from "../../util/random.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";

/** Non-literal on purpose: tsc must not resolve it while `src/session/` does not exist yet. */
export const SESSION_MODULE: string = "../../session/index.js";

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

// ---------------------------------------------------------------------------------------------
// Contract with src/session (Task A's exports must satisfy these signatures).

export interface HostPort {
  host: string;
  port: number;
}

export interface JoinRequest {
  device: string;
  /** Remote address of the joining socket. */
  address: string;
  /** `xxxx-xxxx-xxxx-xxxx`, shown on both sides for the human to compare. */
  fingerprint: string;
}

export interface MasterOptions {
  /** Omit to use the default LAN address and port chosen by the CLI. */
  listen?: HostPort;
  repo: string;
  device: string;
  /** 32 hex chars; control frames must carry it. */
  controlToken: string;
  clock?: Clock;
  random?: RandomSource;
  /**
   * Called for the initial code and on every rotation (use, MAC failure, 600 s TTL). May fire
   * before `startMaster` resolves. `code` is `NNNN-NNNN-NNNN`; `expiresAtMs` is wall-clock.
   */
  onJoinCode(info: { code: string; expiresAtMs: number }): void;
  acceptJoin(request: JoinRequest): Promise<boolean>;
}

export interface MasterHandle {
  /** Bound address. Null when the master was attached to streams instead of a port. */
  readonly address: { host: string; port: number } | null;
  readonly sessionId: string;
  /** Resolves when the master has shut down. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface Capability {
  repo: string;
  head: string;
  role: string;
}

export interface DatalistEntry {
  kind: "path" | "schema" | "signature";
  path: string;
  detail?: string;
}

export interface PlanItem {
  itemId: string;
  repo: string;
  assignee: string;
  epoch: number;
  title: string;
  datalistEntries: number;
}

export interface ItemResult {
  itemId: string;
  epoch: number;
  repo: string;
  baseSha: string;
  headSha: string;
  checks: { name: string; status: "pass" | "fail" | "skip" }[];
  summary: string;
}

export interface SubOptions {
  target: HostPort;
  /** 12 digits, or the displayed `NNNN-NNNN-NNNN` form. The session module normalizes it. */
  code: string;
  device: string;
  clock?: Clock;
  random?: RandomSource;
  /** Optional early notice of the handshake fingerprint, before the master decides. */
  onFingerprint?(fingerprint: string): void;
  describe(): Promise<Capability>;
  /** Repo the master asked about. The CLI lists paths in that checkout. */
  collectDatalist(repo: string): Promise<DatalistEntry[]>;
  /** A plan item assigned to this sub. `null` means the item was shown but not executed. */
  onItem(item: PlanItem): Promise<ItemResult | null>;
}

export interface SubHandle {
  sessionId: string;
  peerId: string;
  fingerprint: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface SessionApi {
  startMaster(options: MasterOptions): Promise<MasterHandle>;
  connectSub(options: SubOptions): Promise<SubHandle>;
}

export type SessionCliContext = CliContext & {
  sessionApi?: SessionApi;
  stdin?: Readable;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
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
  let mod: Partial<SessionApi>;
  try {
    mod = (await import(SESSION_MODULE)) as Partial<SessionApi>;
  } catch (error) {
    throw new CliError(
      "session_unavailable",
      `session mode is not available in this build: ${errorMessage(error)}`,
    );
  }
  if (typeof mod.startMaster !== "function" || typeof mod.connectSub !== "function") {
    throw new CliError("session_unavailable", "session module lacks startMaster/connectSub");
  }
  return mod as SessionApi;
}

/** Git with only the variables it needs: `execFileChecked` never inherits the environment. */
async function git(ctx: CliContext, args: string[]): Promise<string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = ctx.env[key];
    if (value !== undefined) env[key] = value;
  }
  return (await execFileChecked("git", args, { env })).stdout;
}

async function defaultRepo(ctx: CliContext): Promise<string> {
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

  close(): void {
    this.rl.close();
  }
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
    .action(async (opts: JoinOptions) => {
      await joinCommand(sctx, opts);
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
  const acceptJoin = (request: JoinRequest): Promise<boolean> => {
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
  const api = await loadSessionApi(ctx);
  const output = ctx.output();

  let fingerprintShown = false;
  const showFingerprint = (fingerprint: string): void => {
    if (fingerprintShown) return;
    fingerprintShown = true;
    output.result(
      { event: "fingerprint", fingerprint },
      () => `fingerprint ${fingerprint} — check that the master shows the same\n`,
    );
  };

  const handle = await api.connectSub({
    target,
    code,
    device,
    clock: systemClock,
    random: cryptoRandom,
    onFingerprint: showFingerprint,
    describe: async () => ({ repo, role, head: (await git(ctx, ["rev-parse", "HEAD"])).trim() }),
    collectDatalist: async () => {
      const listed = await git(ctx, ["ls-files", "-z"]);
      return listed
        .split("\0")
        .filter((file) => file.length > 0 && file.length <= MAX_DATALIST_PATH)
        .map((file) => ({ kind: "path" as const, path: file }));
    },
    onItem: async (item) => {
      output.result(
        { event: "item", item },
        () => `item ${item.itemId} (epoch ${item.epoch}, ${item.repo}): ${item.title}\n`,
      );
      return null;
    },
  });

  const stop = (): void => {
    void handle.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    showFingerprint(handle.fingerprint);
    const { sessionId, peerId } = handle;
    const at = formatHostPort(target);
    output.result(
      { event: "joined", sessionId, peerId, target: at },
      () => `joined session ${sessionId} at ${at} as ${peerId}\n`,
    );
    await handle.closed;
    output.result({ event: "closed" }, () => "session closed\n");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
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
              item.title,
            ]),
          ),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
