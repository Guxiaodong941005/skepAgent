#!/usr/bin/env node
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { z } from "zod";
import { CodexAdapter } from "../adapter/codex.js";
import { buildPlanPrompt, buildReviewPrompt } from "../adapter/prompts.js";
import { runStructured } from "../adapter/structured.js";
import { BlackboardClone } from "../blackboard/clone.js";
import { HeartbeatWriter, readHeartbeats } from "../blackboard/heartbeat.js";
import { LivenessTracker } from "../blackboard/liveness.js";
import { Publisher, withCloneLock } from "../blackboard/publisher.js";
import { Sync } from "../blackboard/sync.js";
import { GhCodeHost } from "../codehost/gh.js";
import type { CodeHost } from "../codehost/types.js";
import { findRepo, loadDeviceConfig } from "../config/device.js";
import { skepHome, skepPaths } from "../config/paths.js";
import { workersOf } from "../controller/pull-notify.js";
import { intentFromSpec } from "../core/intent-spec.js";
import { draft, type Intent } from "../core/intents.js";
import type { TaskState } from "../core/reducer/state.js";
import type { DeviceConfig } from "../core/schemas/config.js";
import type { Evidence } from "../core/schemas/evidence.js";
import { PlanSchema } from "../core/schemas/plan.js";
import { type Review, ReviewSchema } from "../core/schemas/review.js";
import { Daemon, DaemonError } from "../daemon/daemon.js";
import { createDeliveryDuty } from "../daemon/delivery.js";
import { Duties } from "../daemon/duties.js";
import { IpcServer, type IpcServerOptions } from "../daemon/ipc-server.js";
import { DaemonLock } from "../daemon/lock.js";
import { createReplanDuty } from "../daemon/replan.js";
import { type Slot, type SlotConfig, SlotRegistry } from "../daemon/slots.js";
import { AttemptRunner } from "../exec/attempt.js";
import { ChecksRunner } from "../exec/checks.js";
import { EvidenceVerifier } from "../exec/evidence.js";
import { runInterruptLadder } from "../exec/interrupt.js";
import { Journal } from "../exec/journal.js";
import { findSecrets, Redactor } from "../exec/redact.js";
import type { AgentUserIds } from "../exec/sandbox-env.js";
import { CodeMirror } from "../exec/worktree.js";
import { NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { reverify } from "../lease/reverify.js";
import { SuspendDetector } from "../lease/suspend.js";
import { NativeRuntime, readStartToken } from "../runtime/native.js";
import type { RuntimeBackend } from "../runtime/types.js";
import { NullHintChannel } from "../transport/null-hint.js";
import { type Clock, systemClock } from "../util/clock.js";
import { cryptoRandom, newBootId, type RandomSource } from "../util/random.js";

export interface DaemonBootstrapOptions {
  home: string;
  slots: SlotConfig[];
  env: NodeJS.ProcessEnv;
  clock?: Clock;
  random?: RandomSource;
  request?: typeof fetch;
  resolveIntent(spec: unknown): Intent | null;
  defaultSlot?: Omit<SlotConfig, "roleDir">;
  ipcFactory(options: IpcServerOptions): Pick<IpcServer, "start" | "stop">;
}

/** Keep protocol repo aliases and git transport URLs out of gh's owner/repo arguments (§11.5). */
export function bindCodeHost(host: CodeHost, config: DeviceConfig): CodeHost {
  const resolveRepo = (ref: string): string => {
    const repo = findRepo(config, ref);
    if (!repo) throw new DaemonError("Code host repository is not in the device's local allowlist");
    const remote = repo.url.replace(/\/+$/, "").replace(/\.git$/i, "");
    if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(remote)) return remote;
    const scp = /^git@([^/:]+):(.+)$/.exec(remote);
    let url: URL;
    try {
      url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    } catch (cause) {
      throw new DaemonError("Configure a code host URL naming an owner and repository", { cause });
    }
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password !== "" ||
      (url.username !== "" && (url.protocol !== "ssh:" || url.username !== "git")) ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(url.pathname)
    )
      throw new DaemonError(
        "Code host URLs must name owner/repo without credentials, ports or queries",
      );
    // GhCodeHost extracts the hostname for API calls and gh accepts the same HTTPS repo URL for PRs.
    return `https://${url.hostname}${url.pathname}`;
  };
  return {
    remoteBranchSha: async (repo, branch) => host.remoteBranchSha(resolveRepo(repo), branch),
    findPr: async (repo, head) => host.findPr(resolveRepo(repo), head),
    createPr: async (repo, params) => host.createPr(resolveRepo(repo), params),
    retargetPr: async (repo, pr, base) => host.retargetPr(resolveRepo(repo), pr, base),
    closePr: async (repo, pr, comment) => host.closePr(resolveRepo(repo), pr, comment),
    prState: async (repo, pr) => host.prState(resolveRepo(repo), pr),
  };
}

/** ARCHITECTURE §9.5: journal evidence can refer to any local attempt, including older epochs. */
export async function verifyReviewEvidence(
  review: Review,
  task: Pick<TaskState, "task_id" | "epochs">,
  verifier: Pick<EvidenceVerifier, "verify">,
): Promise<Review> {
  const verify = async (input: Evidence): Promise<boolean> => {
    // File spans are verified against git; their verifier never reads this journal context.
    if (input.type === "file_span")
      return verifier.verify(input, { task: task.task_id, item: "W1", epoch: 1 });
    for (const [item, highestEpoch] of Object.entries(task.epochs).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (let epoch = highestEpoch; epoch > 0; epoch--)
        if (await verifier.verify(input, { task: task.task_id, item, epoch })) return true;
    }
    return false;
  };
  const blockers: Review["blockers"] = [];
  for (const blocker of review.blockers) {
    const evidence: Evidence[] = [];
    for (const input of blocker.evidence) if (await verify(input)) evidence.push(input);
    if (evidence.length > 0) blockers.push({ ...blocker, evidence });
  }
  return {
    ...review,
    blockers,
    verdict: review.verdict === "block" && blockers.length === 0 ? "comment" : review.verdict,
  };
}

/** CLI schema/last-message files live outside the read-only checkout and the protected mirror. */
export function bindAgentRuntime(
  runtime: RuntimeBackend,
  identity: Partial<AgentUserIds>,
  invocationRoot: string,
): RuntimeBackend {
  return {
    name: runtime.name,
    isAlive: runtime.isAlive.bind(runtime),
    spawn: async (opts) => {
      if (identity.gid !== undefined) {
        if (opts.argv.includes("--version")) await chmod(opts.cwd, 0o755);
        for (const flag of ["--output-schema", "--output-last-message"]) {
          const index = opts.argv.indexOf(flag);
          const file = index < 0 ? undefined : opts.argv[index + 1];
          if (!file) continue;
          const root = resolve(invocationRoot);
          const within = relative(root, resolve(file));
          if (within === "" || isAbsolute(within) || within === ".." || within.startsWith("../"))
            throw new DaemonError("Adapter output files must stay in the invocation directory");
          let dir = dirname(resolve(file));
          const parent = dir;
          while (true) {
            await chown(dir, -1, identity.gid);
            await chmod(dir, dir === parent ? 0o770 : 0o750);
            if (dir === root) break;
            dir = dirname(dir);
          }
          if (flag === "--output-schema") {
            await chown(file, -1, identity.gid);
            await chmod(file, 0o640);
          }
        }
      }
      return runtime.spawn({ ...opts, ...identity });
    },
  };
}

/** Native wiring stays at the boundary; daemon scheduling itself has no ambient I/O. */
export async function createDeviceDaemon(options: DaemonBootstrapOptions): Promise<Daemon> {
  const paths = skepPaths(options.home);
  const config = await loadDeviceConfig(paths.deviceToml);
  const clock = options.clock ?? systemClock;
  const random = options.random ?? cryptoRandom;
  const bootId = newBootId(random);
  const token = await readStartToken(process.pid);
  if (!token)
    throw new DaemonError("Cannot read daemon start token; refusing to acquire a device lock");
  const lock = new DaemonLock({
    path: paths.lockFile,
    identity: { pid: process.pid, startToken: token, bootId },
    isAlive: async (pid, expected) => (await readStartToken(pid)) === expected,
  });
  await lock.acquire();
  try {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await chmod(paths.home, 0o700);
    const git = new NodeGitRunner();
    const clone = new BlackboardClone({
      git,
      dir: config.blackboard.clone_path ?? paths.blackboardClone,
      remoteUrl: config.blackboard.url,
    });
    await clone.init();
    const signer = new SshKeySigner({
      principal: `daemon:${config.device}`,
      keyPath: config.signing_key,
    });
    const hints = new NullHintChannel();
    const redactor = new Redactor();
    const liveness = new LivenessTracker(clock);
    let daemon: Daemon;
    const slots = new SlotRegistry({
      device: config.device,
      adapter: async (policy, slotConfig, identity) => {
        if (policy.frontMatter.agent_cli !== "codex")
          throw new DaemonError("MVP supports the pinned Codex adapter only");
        const roleState = join(resolve(slotConfig.roleDir), ".skep");
        const invocationRoot = join(roleState, "invocations");
        await mkdir(invocationRoot, { recursive: true, mode: 0o700 });
        if (identity.gid !== undefined) {
          await chown(roleState, -1, identity.gid);
          await chmod(roleState, 0o710);
          await chown(invocationRoot, -1, identity.gid);
          await chmod(invocationRoot, 0o750);
        }
        const runtime = bindAgentRuntime(new NativeRuntime({ clock }), identity, invocationRoot);
        return new CodexAdapter({
          runtime,
          clock,
          interrupt: runInterruptLadder,
          probeEnv: { PATH: slotConfig.path },
        });
      },
    });
    for (const slotConfig of options.slots) await slots.start(slotConfig);
    const sync = new Sync({
      git,
      clone,
      trustPath: paths.allowedSigners,
      clock,
      rng: random,
      hints,
      intervals: { activeMs: config.poll.active_sec * 1_000, idleMs: config.poll.idle_sec * 1_000 },
      isActive: (state) => slots.isActive(state),
      onFetch: async (state) => {
        const observations = await readHeartbeats(
          git,
          clone.dir,
          paths.allowedSigners,
          Object.fromEntries(
            Object.values(state.agents).map((agent) => [agent.agent, agent.device]),
          ),
        );
        for (const [agent, observation] of Object.entries(observations)) {
          liveness.observe(agent, observation.oid, observation.hb);
          if (observation.problem)
            daemon?.alarm(new DaemonError(observation.problem), "heartbeat_invalid");
        }
      },
    });
    const publisher = new Publisher({
      git,
      clone,
      signer,
      clock,
      rng: random,
      state: sync,
      ident: { name: "Skep Daemon", email: "skepd@example.invalid", timestampSec: 0, tz: "+0000" },
    });
    const services = new Map<
      string,
      {
        mirror: CodeMirror;
        checks: ChecksRunner;
        journal: Journal;
        attempt: AttemptRunner;
        evidence: EvidenceVerifier;
        codeHost: CodeHost;
      }
    >();
    const getServices = (slot: Slot) => {
      const existing = services.get(slot.agent);
      if (existing) return existing;
      const identity =
        slot.identity.uid !== undefined && slot.identity.gid !== undefined
          ? { uid: slot.identity.uid, gid: slot.identity.gid }
          : undefined;
      const mirror = new CodeMirror({
        git,
        home: join(paths.home, "code", slot.agent),
        repos: config.repos,
        worktreeRoot: join(slot.roleDir, ".skep/worktrees"),
        agentUser: identity,
      });
      const journal = new Journal({ roleDir: slot.roleDir, clock, redactor });
      const checks = new ChecksRunner({
        git,
        mirror,
        journal,
        clock,
        env: slot.envOptions,
        agentUser: identity,
        random,
      });
      const codeHost = bindCodeHost(
        new GhCodeHost({
          env: { PATH: options.env.PATH ?? "", HOME: options.env.HOME ?? paths.home },
        }),
        config,
      );
      const attempt = new AttemptRunner({
        mirror,
        git,
        signer,
        ident: { name: "Skep Daemon", email: "skepd@example.invalid", tz: "+0000" },
        agentEnv: slot.envOptions,
        adapter: (runtime, interrupt) =>
          new CodexAdapter({
            runtime: bindAgentRuntime(
              runtime,
              slot.identity,
              join(slot.roleDir, ".skep/invocations"),
            ),
            clock,
            interrupt,
            probeEnv: { PATH: slot.env.PATH ?? "" },
          }),
        checks,
        redactor,
        codeHost,
        reverify: (lease) => reverify(sync, lease),
        publisher: { publish: (intent, opts) => daemon.publish(intent, opts) },
        journal,
        clock,
        random,
        scratchDir: join(slot.roleDir, ".skep/invocations"),
      });
      const result = {
        mirror,
        checks,
        journal,
        attempt,
        codeHost,
        evidence: new EvidenceVerifier({ git, mirror, journal }),
      };
      services.set(slot.agent, result);
      return result;
    };
    await mkdir(join(paths.home, "scratch"), { recursive: true, mode: 0o700 });
    const invoke = async <T>(
      slot: Slot,
      kind: "plan" | "review",
      repo: string,
      commit: string,
      prompt: string,
      schema: z.ZodType<T>,
      signal: AbortSignal,
    ): Promise<T> => {
      if (findSecrets(prompt).length > 0)
        throw new DaemonError(
          "Secret scan blocked model context; inspect the pinned repository locally",
        );
      const { mirror } = getServices(slot);
      const scratch = await mkdtemp(join(slot.roleDir, ".skep/invocations", `${kind}-`));
      const checkout = join(scratch, "checkout");
      await mkdir(checkout, { mode: 0o755 });
      await chmod(scratch, 0o755);
      const dir = await mirror.fetch(repo);
      await git.run(
        [
          "--git-dir",
          dir,
          "--work-tree",
          checkout,
          "restore",
          "--source",
          commit,
          "--worktree",
          "--",
          ".",
        ],
        { cwd: dir },
      );
      const readonly = async (path: string): Promise<void> => {
        const info = await lstat(path);
        if (info.isSymbolicLink()) return;
        if (info.isDirectory()) {
          for (const child of await readdir(path)) await readonly(join(path, child));
          await chmod(path, 0o555);
        } else await chmod(path, info.mode & 0o111 ? 0o555 : 0o444);
      };
      await readonly(checkout);
      const capture = join(scratch, "capture");
      await mkdir(capture, { mode: 0o700 });
      const safeAdapter = {
        cli: slot.adapter.cli,
        probe: () => slot.adapter.probe(),
        invoke: async (inv: Parameters<Slot["adapter"]["invoke"]>[0]) => {
          const result = await slot.adapter.invoke(inv);
          if (result.finalMessage && findSecrets(result.finalMessage).length > 0)
            throw new DaemonError(
              "Secret scan blocked model output; no protocol content was published",
            );
          return {
            ...result,
            finalMessage:
              result.finalMessage === null ? null : redactor.redact(result.finalMessage),
          };
        },
      };
      try {
        const result = await runStructured(
          safeAdapter,
          {
            kind,
            cwd: checkout,
            prompt: redactor.redact(prompt),
            outputSchema: {},
            timeoutMs: slot.policy.frontMatter.budgets.max_invocation_minutes * 60_000,
            env: slot.env,
            logPath: join(capture, "raw.log"),
            scratchDir: capture,
            signal,
          },
          schema,
        );
        if (!result.ok) throw new DaemonError(`${kind} invocation failed: ${result.error}`);
        return result.value;
      } finally {
        try {
          const log = await readFile(join(capture, "raw.log"), "utf8");
          await mkdir(join(slot.roleDir, ".skep"), { recursive: true, mode: 0o700 });
          await writeFile(join(slot.roleDir, ".skep", `${kind}.log`), redactor.redact(log), {
            mode: 0o600,
          });
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
            daemon.alarm(cause, "capture_failed");
        }
        const writable = async (path: string): Promise<void> => {
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) return;
          await chmod(path, 0o755);
          for (const child of await readdir(path)) await writable(join(path, child));
        };
        await writable(checkout);
        await rm(scratch, { recursive: true, force: true });
      }
    };
    const duties = new Duties({
      slots,
      clock,
      random,
      publisher: { publish: (intent, opts) => daemon.publish(intent, opts) },
      current: () => daemon.current(),
      onError: (error) => daemon.alarm(error),
      onWarning: (message) => daemon.alarm(new DaemonError(message), "plan_warning"),
      wake: () => daemon.wake(),
      attempt: (slot) => getServices(slot).attempt,
      replan: createReplanDuty({
        clock,
        journal: (slot) => getServices(slot).journal,
        notify: async (message) => daemon.alarm(new DaemonError(message), "replan"),
      }),
      delivery: createDeliveryDuty({
        clock,
        git,
        mirror: (slot) => getServices(slot).mirror,
        checks: (slot) => getServices(slot).checks,
        codeHost: (slot) => getServices(slot).codeHost,
        notify: async (message) => daemon.alarm(new DaemonError(message), "delivery"),
      }),
      recordStale: (slot, lease) =>
        getServices(slot).journal.append(
          { task: lease.task_id, item: lease.item, epoch: lease.epoch },
          { step: "stale" },
        ),
      validation: (slot, state, task) => ({
        state,
        task,
        loadChecks: (repo, commit) => getServices(slot).checks.load(repo, commit),
        pathExists: async (repo, commit, path) => {
          if (path === ".") return true;
          const dir = await getServices(slot).mirror.mirrorPath(repo);
          return (
            (
              await git.run(["cat-file", "-e", `${commit}:${path.replace(/\/$/, "")}`], {
                cwd: dir,
                allowFailure: true,
              })
            ).code === 0
          );
        },
      }),
      plan: async (slot, task, state, signal) => {
        const { mirror, checks } = getServices(slot);
        const dir = await mirror.fetch(task.repo);
        const commit = (
          await git.run(
            ["rev-parse", "--verify", `refs/remotes/origin/${task.base_branch}^{commit}`],
            { cwd: dir },
          )
        ).stdout.trim();
        const trusted = await checks.load(task.repo, commit);
        const parent = task.plans[String(task.current_plan_version)];
        return invoke(
          slot,
          "plan",
          task.repo,
          commit,
          buildPlanPrompt({
            agentInstructions: slot.policy.body,
            repoContext: "Read the pinned checkout; it has no usable git metadata.",
            task,
            baseCommit: commit,
            version: (task.current_plan_version ?? 0) + 1,
            agents: Object.values(state.agents).map((agent) => ({
              agent: agent.agent,
              device: agent.device,
              role: agent.profile.role,
              capabilities: agent.profile.capabilities,
              requires_local: agent.profile.requires_local,
            })),
            checks: Object.keys(trusted.checks).sort(),
            parentPlan: parent?.plan ?? null,
            reviews: Object.values(parent?.reviews ?? {}).map((review) => ({
              schema: "skep.review/v1" as const,
              ...review.payload,
            })),
            checkpoints: Object.values(task.items).flatMap((item) =>
              item.last_checkpoint ? [item.last_checkpoint] : [],
            ),
          }),
          PlanSchema,
          signal,
        );
      },
      review: (slot, plan, hash, signal) =>
        invoke(
          slot,
          "review",
          plan.base.repo,
          plan.base.commit,
          buildReviewPrompt({
            agentInstructions: slot.policy.body,
            repoContext: "Read the pinned checkout; it has no usable git metadata.",
            plan,
            planHash: hash,
          }),
          ReviewSchema,
          signal,
        ),
      verifyReview: (review, task, slot) =>
        verifyReviewEvidence(review, task, getServices(slot).evidence),
    });
    const heartbeatWriters = new Map<string, HeartbeatWriter>();
    let ipc: ReturnType<DaemonBootstrapOptions["ipcFactory"]>;
    daemon = new Daemon({
      sync,
      publisher,
      slots,
      duties,
      suspend: new SuspendDetector(clock, config.poll.active_sec * 1_000, (error) =>
        daemon.alarm(error),
      ),
      liveness,
      clock,
      random,
      hints,
      redactor,
      workers: workersOf(config),
      notify: config.notify
        ? async (alarm) => {
            const response = await (options.request ?? fetch)(config.notify?.ntfy_topic_url ?? "", {
              method: "POST",
              body: redactor.redact(`${alarm.kind}: ${alarm.message}`),
            });
            if (!response.ok)
              throw new DaemonError(`Notification request failed (${response.status})`);
          }
        : undefined,
      activeMs: config.poll.active_sec * 1_000,
      idleMs: config.poll.idle_sec * 1_000,
      lock: { acquire: async () => {}, release: () => lock.release() },
      ipc: { start: () => ipc.start(), stop: () => ipc.stop() },
      resolveIntent: options.resolveIntent,
      slotConfig: (roleDir) => {
        const configured = options.slots.find((slot) => resolve(slot.roleDir) === resolve(roleDir));
        if (configured) return configured;
        if (!options.defaultSlot)
          throw new DaemonError("No trusted local slot configuration for that role directory");
        return { ...options.defaultSlot, roleDir };
      },
      heartbeat: (agent) => {
        let writer = heartbeatWriters.get(agent);
        if (!writer) {
          writer = new HeartbeatWriter({
            git,
            repoDir: clone.dir,
            agent,
            signer,
            clock,
            bootId,
            onAlarm: (alarm) => daemon.alarm(alarm, "duplicate-daemon"),
          });
          heartbeatWriters.set(agent, writer);
        }
        const heartbeat = writer;
        return { beat: (draft) => withCloneLock(clone, () => heartbeat.beat(draft)) };
      },
      logsTail: async (agent) => {
        const slot = slots.get(agent);
        if (!slot) throw new DaemonError("No local log reader for that agent");
        return {
          agent,
          text: await (async () => {
            const candidates: { path: string; modified: number }[] = [];
            const collect = async (path: string): Promise<void> => {
              const info = await lstat(path);
              if (info.isSymbolicLink()) return;
              if (info.isDirectory()) {
                for (const name of await readdir(path))
                  if (name !== "worktrees") await collect(join(path, name));
              } else if (info.isFile() && path.endsWith(".log"))
                candidates.push({ path, modified: info.mtimeMs });
            };
            try {
              await collect(join(slot.roleDir, ".skep"));
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            const latest = candidates.sort(
              (a, b) => b.modified - a.modified || a.path.localeCompare(b.path),
            )[0];
            return latest ? redactor.redact(await readFile(latest.path, "utf8")) : "";
          })(),
        };
      },
    });
    ipc = options.ipcFactory({
      socketPath: paths.socket,
      handlers: daemon.handlers(),
      redactor,
    });
    try {
      await sync.observeNow();
    } catch (error) {
      daemon.alarm(error, "sync_failed");
      if (daemon.status().extras.readOnly) return daemon;
      throw error;
    }
    for (const slot of slots.list()) {
      const profile = slot.policy.frontMatter;
      const registration = await publisher.publish(() =>
        draft(
          "agent.registered",
          null,
          slot.agent,
          {
            role: profile.role,
            agent_cli: profile.agent_cli,
            cli_version: profile.cli_version,
            capabilities: profile.capabilities,
            requires_local: profile.requires_local,
            max_parallel_items: profile.max_parallel_items,
          },
          {},
        ),
      );
      if (registration.status !== "accepted")
        throw new DaemonError(
          `Slot registration failed: ${registration.reason ?? registration.status}`,
        );
      const state = daemon.current();
      await hints.publish({
        v: 1,
        kind: "tip",
        topic: state.blackboard_id,
        ref: "main",
        sha: state.tip,
      });
    }
    return daemon;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function runDaemon(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  bootstrap: (
    options: DaemonBootstrapOptions,
  ) => Promise<Pick<Daemon, "start" | "stop">> = createDeviceDaemon,
): Promise<void> {
  const program = new Command()
    .name("skepd")
    .description("Run the per-device Skep daemon with a local Unix socket")
    .option("--home <dir>", "Skep state directory")
    .option("--socket-group <name>", "local group for a 0660 socket and 0750 socket directory")
    .option("--role-dir <dir...>", "trusted role directories")
    .option("--agent-user <user>", "local OS user for agent subprocesses")
    .option("--agent-home <dir>", "agent user's local home directory")
    .option("--agent-path <path>", "explicit executable PATH for agents")
    .option("--agent-config-dir <dir>", "local CLI config directory");
  program.exitOverride();
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if ((error as { code?: string }).code === "commander.helpDisplayed") return;
    throw error;
  }
  const args = program.opts<{
    home?: string;
    socketGroup?: string;
    roleDir?: string[];
    agentUser?: string;
    agentHome?: string;
    agentPath?: string;
    agentConfigDir?: string;
  }>();
  if ((args.roleDir?.length ?? 0) > 0 && (!args.agentUser || !args.agentHome || !args.agentPath))
    throw new DaemonError("Slots require --agent-user, --agent-home and --agent-path");
  const clock = systemClock;
  const random = cryptoRandom;
  const daemon = await bootstrap({
    clock,
    random,
    ...(args.agentUser && args.agentHome && args.agentPath
      ? {
          defaultSlot: {
            user: args.agentUser,
            home: args.agentHome,
            path: args.agentPath,
            ...(args.agentConfigDir ? { configDir: args.agentConfigDir } : {}),
          },
        }
      : {}),
    home: args.home ?? skepHome(env),
    env,
    slots: (args.roleDir ?? []).map((roleDir) => ({
      roleDir,
      user: args.agentUser ?? "",
      home: args.agentHome ?? "",
      path: args.agentPath ?? "",
      ...(args.agentConfigDir ? { configDir: args.agentConfigDir } : {}),
    })),
    resolveIntent: (spec) => intentFromSpec(spec, { rng: random, nowMs: clock.nowMs() }),
    ipcFactory: (options) =>
      new IpcServer({
        ...options,
        ...(args.socketGroup !== undefined ? { group: args.socketGroup, mode: 0o660 } : {}),
      }),
  });
  let resolveStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const stop = () => resolveStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await daemon.start();
    await stopped;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await daemon.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDaemon(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`skepd: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
