/**
 * Publishing a human intent (ARCHITECTURE §7.4, §12).
 *
 * The daemon is the writer when it is up: the CLI sends `publish` with `signer: "human"` and
 * signs each write-loop attempt through the socket callback, so the human key never leaves this
 * process. When the daemon is down the CLI runs the same {@link Publisher} in-process against
 * `$SKEP_HOME/cli-blackboard` (ARCHITECTURE §3). Both paths build the event with
 * {@link intentFromSpec}, so a spec the daemon would drop is a spec the fallback drops too.
 */

import { access } from "node:fs/promises";
import { BlackboardClone } from "../blackboard/clone.js";
import { fullReplaySource, Publisher, type PublishResult } from "../blackboard/publisher.js";
import { loadDeviceConfig } from "../config/device.js";
import { ConfigError } from "../config/errors.js";
import { type IntentSpec, intentFromSpec } from "../core/intent-spec.js";
import type { EventDraft, Intent } from "../core/intents.js";
import type { PlanRecord, State } from "../core/reducer/state.js";
import { NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { type IpcClient, IpcClientError, signerCallback } from "../ipc/client.js";
import type { IpcMethod, ParamsOf } from "../ipc/protocol.js";
import { systemClock } from "../util/clock.js";
import { cryptoRandom } from "../util/random.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT } from "./output.js";

/** What the CLI prints for one publication: the publisher's verdict plus the seq it landed at. */
export interface Published {
  status: "accepted" | "rejected" | "dropped" | "failed";
  seq?: number;
  reason?: string;
  eventId?: string;
  /** Set for a plan decision: the version and hash the intent named (review note 1). */
  plan?: { version: number; planHash: string };
}

const HUMAN_IDENT = {
  name: "Human",
  email: "human@example.invalid",
  timestampSec: 0,
  tz: "+0000",
};

/**
 * Publish `spec` and return the verdict.
 *
 * Throws {@link CliError} for anything that is not a verdict: no daemon and no usable local
 * config, a spec the mapping refuses, or a publish that could not be attempted. A `rejected`,
 * `dropped` or `failed` verdict is returned, not thrown — the command decides the exit code.
 */
export async function publishHuman(ctx: CliContext, spec: IntentSpec): Promise<Published> {
  const client = await connectOrNull(ctx);
  if (client) {
    try {
      return await publishThroughDaemon(client, spec, ctx);
    } finally {
      client.close();
    }
  }
  return publishInProcess(ctx, spec);
}

async function connectOrNull(ctx: CliContext): Promise<IpcClient | null> {
  const connect = ctx.connectDaemon ?? (async () => Promise.reject(new Error("no daemon")));
  try {
    return await connect();
  } catch (err) {
    // Only "nothing is listening" falls back. A daemon that died mid-handshake is reported.
    if (err instanceof IpcClientError && err.code === "connect") return null;
    if (isAbsentSocket(err)) return null;
    throw new CliError("daemon_unavailable", messageOf(err), EXIT.error);
  }
}

async function publishThroughDaemon(
  client: IpcClient,
  spec: IntentSpec,
  ctx: CliContext,
): Promise<Published> {
  // The key is resolved lazily: a daemon that never asks for a signature (it signs itself, or
  // the publish is refused first) must not require a human key on this machine.
  let response: Awaited<ReturnType<IpcClient["call"]>>;
  try {
    response = await client.call(
      "publish",
      { intent: spec, signer: "human" },
      {
        sign: async (payload, principal) => {
          const sign = signerCallback(await humanSigner(ctx));
          if (!sign) throw new Error("human signer has no callback");
          return sign(payload, principal);
        },
      },
    );
  } catch (err) {
    throw new CliError("publish_failed", messageOf(err), EXIT.error);
  }
  if (!response.ok) {
    throw new CliError(response.error.code, response.error.message, EXIT.error);
  }
  return publishedFrom(response.result);
}

/**
 * Call one daemon method. Returns `undefined` when no daemon is listening, so the caller can
 * fall back to its own clone; a daemon that answers with an error is reported as-is.
 */
export async function callDaemon<M extends IpcMethod>(
  ctx: CliContext,
  method: M,
  params: ParamsOf<M>,
): Promise<unknown | undefined> {
  const client = await connectOrNull(ctx);
  if (!client) return undefined;
  try {
    const response = await client.call(method, params);
    if (!response.ok) throw new CliError(response.error.code, response.error.message, EXIT.error);
    return response.result;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("daemon_unavailable", messageOf(err), EXIT.error);
  } finally {
    client.close();
  }
}

/** One plan version as `skep plan show` prints it. Reviews and overrides included (PRD §15.2). */
export interface PlanView {
  task_id: string;
  status: string;
  version: number;
  plan_hash: string;
  base: { repo: string; branch: string; commit: string };
  summary: string;
  items: { id: string; title: string; assignee: string; status: string; depends_on: string[] }[];
  reviews: { reviewer: string; verdict: string; seq: number }[];
  locked: {
    seq: number;
    overrides: { reviewer: string; blocker_id: string; rationale: string }[];
  } | null;
  decision: { kind: string; seq: number; note: string | null } | null;
  changes_from_parent: string | null;
}

/**
 * The plan `skep plan show` renders, replayed from the CLI's own clone (ARCHITECTURE §3).
 * `version` defaults to the latest proposed plan. The daemon's `log` method returns outcomes,
 * which `skep log` renders; a plan needs the state, so it is always read locally.
 */
export async function loadPlanView(
  ctx: CliContext,
  taskId: string,
  version: number | undefined,
): Promise<PlanView> {
  const state = await replayLocal(ctx);
  const view = planViewOf(state, taskId, version);
  if (!view) {
    const which = version === undefined ? "current plan" : `plan v${version}`;
    throw new CliError("no_plan", `${taskId} has no ${which}`, EXIT.error);
  }
  return view;
}

/** Project one plan version out of reducer state. `null` when the task or version is absent. */
export function planViewOf(state: State, taskId: string, version?: number): PlanView | null {
  const task = state.tasks[taskId];
  if (!task) return null;
  const chosen = version ?? task.current_plan_version;
  if (chosen === null) return null;
  const record = task.plans[String(chosen)];
  if (!record) return null;
  return projectPlan(task.task_id, task.status, record, task.items);
}

function projectPlan(
  taskId: string,
  status: string,
  record: PlanRecord,
  items: State["tasks"][string]["items"],
): PlanView {
  return {
    task_id: taskId,
    status,
    version: record.version,
    plan_hash: record.plan_hash,
    base: record.plan.base,
    summary: record.plan.summary,
    items: record.plan.stack_order.map((id) => {
      const item = record.plan.items.find((candidate) => candidate.id === id);
      return {
        id,
        title: item?.title ?? id,
        assignee: item?.assignee ?? "",
        status: items[id]?.status ?? "proposed",
        depends_on: item?.depends_on ?? [],
      };
    }),
    reviews: Object.values(record.reviews)
      .map((review) => ({
        reviewer: review.reviewer,
        verdict: review.verdict,
        seq: review.seq,
      }))
      .sort((a, b) => a.seq - b.seq),
    locked: record.locked
      ? {
          seq: record.locked.seq,
          overrides: record.locked.overrides.map((override) => ({
            reviewer: override.reviewer,
            blocker_id: override.blocker_id,
            rationale: override.rationale,
          })),
        }
      : null,
    decision: record.decision,
    changes_from_parent: record.plan.changes_from_parent,
  };
}

/**
 * Replay the CLI's private clone far enough to read state (ARCHITECTURE §3). Used by `plan show`
 * when the daemon is down. Throws when the clone or the trust root is missing.
 */
export async function replayLocal(ctx: CliContext): Promise<State> {
  const paths = ctx.paths;
  if (!paths) throw new CliError("no_home", "skep home is not resolved", EXIT.error);
  const device = await readDevice(paths.deviceToml);
  await readable(paths.allowedSigners, "allowed_signers");
  const git = new NodeGitRunner();
  const clone = new BlackboardClone({
    git,
    dir: paths.cliBlackboardClone,
    remoteUrl: device.blackboardUrl,
  });
  try {
    // `init` is idempotent (SK-301): it only (re)creates the private clone and its remote, so a
    // controller whose `skep init` bootstrapped the daemon's clone still gets one here.
    await clone.init();
    await clone.fetch();
    const tip = await clone.resetToRemoteMain();
    return await fullReplaySource(git, clone.dir, paths.allowedSigners).replayTo(tip);
  } catch (err) {
    throw new CliError(
      "no_clone",
      `cannot read ${paths.cliBlackboardClone}: ${messageOf(err)}`,
      EXIT.error,
    );
  }
}

/**
 * The daemon is down: replay the CLI's private clone and publish with the human key
 * (ARCHITECTURE §3, §7.4). The clone is created here if `skep init` never made one — init
 * bootstraps the daemon's clone, not this one.
 */
async function publishInProcess(ctx: CliContext, spec: IntentSpec): Promise<Published> {
  const paths = ctx.paths;
  if (!paths) throw new CliError("no_home", "skep home is not resolved", EXIT.error);
  const device = await readDevice(paths.deviceToml);
  const signer = new SshKeySigner({
    principal: "human",
    keyPath: requireHumanKey(device),
  });
  await readable(paths.allowedSigners, "allowed_signers");

  const git = new NodeGitRunner();
  const clone = new BlackboardClone({
    git,
    dir: paths.cliBlackboardClone,
    remoteUrl: device.blackboardUrl,
  });
  // Idempotent (SK-301): prepares the clone, its remote and refspecs before the first fetch.
  await clone.init();
  const publisher = new Publisher({
    git,
    clone,
    signer,
    clock: systemClock,
    rng: cryptoRandom,
    state: fullReplaySource(git, clone.dir, paths.allowedSigners),
    ident: HUMAN_IDENT,
  });
  const built = intentFromSpec(spec, { rng: cryptoRandom, nowMs: systemClock.nowMs() });
  if (!built)
    throw new CliError("bad_intent", `cannot build an intent for ${spec.kind}`, EXIT.error);
  // Remember the plan the draft names, so the verdict can print the version and hash decided.
  const seen: { plan?: Published["plan"] } = {};
  const intent: Intent = (state) => {
    const draft = built(state);
    const plan = planFromDraft(draft);
    if (plan) seen.plan = plan;
    return draft;
  };
  try {
    const published = publishedFrom(await publisher.publish(intent, { signer }));
    return seen.plan ? { ...published, plan: seen.plan } : published;
  } catch (err) {
    throw new CliError("publish_failed", messageOf(err), EXIT.error);
  }
}

/** The version and hash a plan decision draft carries, if that is what `draft` is. */
function planFromDraft(draft: EventDraft | null): Published["plan"] | undefined {
  if (draft?.type !== "plan.approved" && draft?.type !== "plan.rejected") return undefined;
  const payload = draft.payload as { plan_version?: unknown; plan_hash?: unknown };
  if (typeof payload.plan_version !== "number" || typeof payload.plan_hash !== "string") {
    return undefined;
  }
  return { version: payload.plan_version, planHash: payload.plan_hash };
}

interface DevicePublishConfig {
  file: string;
  blackboardUrl: string;
  /** Absent when device.toml names no human key. Signing needs it; reading state does not. */
  humanKey?: string;
}

/** The device.toml fields the fallback path needs. Everything else stays unread (D19). */
async function readDevice(file: string): Promise<DevicePublishConfig> {
  let cfg: Awaited<ReturnType<typeof loadDeviceConfig>>;
  try {
    cfg = await loadDeviceConfig(file);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new CliError(
        "no_daemon",
        `skepd is not running and ${file} cannot be read (${err.message})`,
        EXIT.error,
      );
    }
    throw new CliError("no_daemon", `skepd is not running and ${messageOf(err)}`, EXIT.error);
  }
  return { file, blackboardUrl: cfg.blackboard.url, humanKey: cfg.human_signing_key };
}

/** The human key, or an error naming the device.toml field that is missing. */
function requireHumanKey(device: DevicePublishConfig): string {
  if (device.humanKey !== undefined) return device.humanKey;
  throw new CliError(
    "no_human_key",
    `${device.file} has no human_signing_key, so a human event cannot be signed while skepd is down`,
    EXIT.error,
  );
}

async function humanSigner(ctx: CliContext): Promise<SshKeySigner> {
  const file = ctx.paths?.deviceToml;
  if (!file) throw new CliError("no_home", "skep home is not resolved", EXIT.error);
  return new SshKeySigner({ principal: "human", keyPath: requireHumanKey(await readDevice(file)) });
}

async function readable(file: string, label: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new CliError("no_trust", `${label} is missing at ${file}`, EXIT.error);
  }
}

/**
 * The daemon answers with its own JSON, so trust only the fields {@link PublishResult} defines.
 * Anything else is a protocol error rather than a guessed verdict.
 */
function publishedFrom(value: unknown): Published {
  if (typeof value !== "object" || value === null) {
    throw new CliError("bad_result", "publish result is not an object", EXIT.error);
  }
  const result = value as Partial<PublishResult>;
  if (
    result.status !== "accepted" &&
    result.status !== "rejected" &&
    result.status !== "dropped" &&
    result.status !== "failed"
  ) {
    throw new CliError("bad_result", "publish result has no status", EXIT.error);
  }
  return {
    status: result.status,
    ...(typeof result.seq === "number" ? { seq: result.seq } : {}),
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(typeof result.eventId === "string" ? { eventId: result.eventId } : {}),
  };
}

/** `connect()` rejects with the raw socket error when the socket file does not exist. */
function isAbsentSocket(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
