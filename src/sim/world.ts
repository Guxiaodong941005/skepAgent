import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlackboardClone } from "../blackboard/clone.js";
import { createGenesis } from "../blackboard/genesis.js";
import { type DuplicateDaemonError, HeartbeatWriter } from "../blackboard/heartbeat.js";
import { Publisher, type PublishResult } from "../blackboard/publisher.js";
import { Sync } from "../blackboard/sync.js";
import { DEVICE_RE, deviceOfAgent, type Sha } from "../core/ids.js";
import type { Intent } from "../core/intents.js";
import { REDUCER_VERSION, type State } from "../core/reducer/state.js";
import { AgentIdSchema, ShaSchema } from "../core/schemas/common.js";
import { type GitRunner, type GitRunOptions, NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { NullHintChannel } from "../transport/null-hint.js";
import { isoUtc } from "../util/clock.js";
import { FakeClock, type FakeClockOptions, VirtualTime } from "./fake-clock.js";
import { type FaultRule, FaultyGitRunner, type SeededFaults } from "./faulty-git.js";
import {
  checkWorldInvariants,
  type SimCodeHost,
  SimInvariantError,
  type SimViolation,
} from "./invariants.js";
import { Rng, rngRandomSource } from "./rng.js";

const START_MS = 1_791_158_400_000;
const keyFixtures = fileURLToPath(new URL("../../test/fixtures/keys/", import.meta.url));

export class SimWorldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimWorldError";
  }
}

export class SimSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimSchedulerError";
  }
}

interface Operation {
  sleeps: number;
  changed: Promise<void>;
  notify: () => void;
  parent?: Operation;
}

function operation(onChange = () => {}, parent?: Operation): Operation {
  let wake: () => void = () => {};
  const op: Operation = {
    sleeps: 0,
    parent,
    changed: Promise.resolve(),
    notify: () => {
      wake();
      op.changed = new Promise<void>((resolveChange) => {
        wake = resolveChange;
      });
      onChange();
    },
  };
  op.notify();
  return op;
}

interface ScheduledAction {
  at: number;
  label: string;
  order: number;
  run: () => void | Promise<void>;
  runnable: () => boolean;
}

/** Serial real I/O, interleaved only at virtual sleeps, keeps host scheduling out of the log. */
export class SimScheduler {
  private readonly actions: ScheduledAction[] = [];
  private readonly context = new AsyncLocalStorage<Operation>();
  private readonly operations = new Set<Operation>();
  private readonly changed = operation();
  private readonly scheduleRng: Rng;
  steps = 0;
  readonly trace: { step: number; at: number; label: string }[] = [];
  onStep?: () => Promise<void>;

  constructor(
    readonly time: VirtualTime,
    rng: Rng,
  ) {
    this.scheduleRng = rng.fork("schedule");
  }

  clock(opts: FakeClockOptions = {}): FakeClock {
    const scheduler = this;
    return new (class extends FakeClock {
      override async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        const pending = super.sleep(ms, signal);
        const op = scheduler.context.getStore();
        if (op) {
          op.sleeps++;
          op.notify();
        }
        try {
          await pending;
        } finally {
          if (op) {
            op.sleeps--;
            op.notify();
          }
        }
      }
    })(this.time, opts);
  }

  schedule(
    at: number,
    label: string,
    run: () => void | Promise<void>,
    runnable = () => true,
  ): () => void {
    if (!Number.isFinite(at) || at < this.time.now || label.length === 0) {
      throw new SimSchedulerError(
        "Schedule an action with a nonempty label at or after virtual now",
      );
    }
    const action = { at, label, run, runnable, order: this.scheduleRng.next() };
    this.actions.push(action);
    return () => {
      const index = this.actions.indexOf(action);
      if (index >= 0) this.actions.splice(index, 1);
    };
  }

  async step(): Promise<boolean> {
    return this.dispatch();
  }

  private async dispatch(driver?: Operation): Promise<boolean> {
    await this.waitForQuiescence(driver);
    const action = this.actions
      .filter((entry) => entry.runnable())
      .sort((a, b) => a.at - b.at || a.order - b.order)[0];
    const timerAt = this.time.nextTimerAt();
    const actionAt = action ? Math.max(this.time.now, action.at) : null;
    const timerFirst =
      timerAt !== null &&
      (actionAt === null ||
        timerAt < actionAt ||
        (timerAt === actionAt && this.scheduleRng.chance(0.5)));
    let label: string;
    if (timerFirst) {
      await this.time.runNext();
      label = "timer";
    } else if (action) {
      this.actions.splice(this.actions.indexOf(action), 1);
      // A selected action must win its seeded tie with a clock timer. advance() would fire all
      // timers at that instant first, so use our own single marker before equal-time timers.
      const marker = this.time.schedule(Math.max(this.time.now, action.at), () => {});
      marker.seq = -1;
      await this.time.runNext();
      await this.execute(action.run);
      label = action.label;
    } else {
      return false;
    }
    // Another actor may have woken while a nested actor was sleeping. Let its real I/O finish
    // or yield again before moving time; otherwise commit dates depend on host I/O speed (§13.1).
    await this.waitForQuiescence(driver?.parent);
    this.trace.push({ step: ++this.steps, at: this.time.now, label });
    await this.onStep?.();
    return true;
  }

  /** Runs an unscheduled actor through the same virtual-sleep driver (e.g. a human publisher). */
  async execute<T>(run: () => Promise<T> | T): Promise<T> {
    const op = operation(() => this.changed.notify(), this.context.getStore());
    this.operations.add(op);
    let settled = false;
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    const result = this.context.run(op, async () => run());
    void result.then(
      (out) => {
        value = out;
        settled = true;
        this.operations.delete(op);
        op.notify();
      },
      (error: unknown) => {
        failure = error;
        failed = true;
        settled = true;
        this.operations.delete(op);
        op.notify();
      },
    );
    while (!settled) {
      const changed = op.changed;
      if (op.sleeps > 0) {
        if (!(await this.dispatch(op))) {
          // An already-aborted or invalid sleep rejects on a microtask without a live timer.
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          if (settled || op.sleeps === 0) continue;
          throw new SimSchedulerError("A suspended actor has no runnable timer or resume action");
        }
      } else {
        // Wait for actual I/O or a newly registered sleep; never guess how long git takes.
        await changed;
      }
    }
    if (failed) throw failure;
    return value as T;
  }

  private async waitForQuiescence(driver?: Operation): Promise<void> {
    const ancestors = new Set<Operation>();
    for (let op = driver; op; op = op.parent) ancestors.add(op);
    // Ancestors wait for this driver's nested call; they cannot make progress independently.
    while ([...this.operations].some((op) => op.sleeps === 0 && !ancestors.has(op))) {
      await this.changed.changed;
    }
  }
}

/** Isolates every simulated git process from the operator's HOME and ambient git configuration. */
class IsolatedGitRunner implements GitRunner {
  private readonly git = new NodeGitRunner();
  constructor(private readonly home: string) {}

  run(args: string[], opts: GitRunOptions) {
    return this.git.run(args, {
      ...opts,
      env: {
        ...opts.env,
        HOME: this.home,
        XDG_CONFIG_HOME: join(this.home, "config"),
        SSH_AUTH_SOCK: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
      },
    });
  }
}

export type SimDuties = (
  node: SimNode,
  state: State,
) => readonly Intent[] | Promise<readonly Intent[]>;

export interface SimDeviceOptions {
  device: string;
  agent?: string;
  skewMs?: number;
  duties?: SimDuties;
  faults?: FaultRule[];
  seededFaults?: Omit<SeededFaults, "rng">;
}

export class SimNode {
  readonly publications: PublishResult[] = [];
  duties?: SimDuties;
  private lastBeatMonoMs: number | null = null;

  constructor(
    readonly device: string,
    readonly agent: string,
    readonly git: FaultyGitRunner,
    readonly clone: BlackboardClone,
    readonly sync: Sync,
    readonly publisher: Publisher,
    readonly heartbeat: HeartbeatWriter,
    readonly clock: FakeClock,
    readonly trustPath: string,
    readonly hints: NullHintChannel,
    readonly alarms: DuplicateDaemonError[],
    duties?: SimDuties,
  ) {
    this.duties = duties;
  }

  get state(): State {
    const state = this.sync.current().state;
    if (!state) throw new SimWorldError(`Node ${this.agent} has not observed genesis`);
    return state;
  }

  async tick(): Promise<void> {
    if (this.clock.suspended) return;
    let state = await this.sync.observeNow();
    for (const intent of (await this.duties?.(this, state)) ?? []) {
      const result = await this.publisher.publish(intent);
      this.publications.push(result);
      if (result.status === "failed") {
        throw new SimWorldError(`Node ${this.agent} could not publish: ${result.reason}`);
      }
    }
    state = this.state;
    const holding = Object.values(state.tasks).flatMap((task) =>
      Object.values(task.items)
        .filter((item) => item.status === "leased" && item.lease?.holder === this.agent)
        .map((item) => ({ task, item })),
    )[0];
    const interval = holding ? 60_000 : 300_000;
    if (
      this.lastBeatMonoMs === null ||
      this.clock.monotonicMs() - this.lastBeatMonoMs >= interval
    ) {
      await this.heartbeat.beat({
        state: holding ? "running" : "idle",
        task_id: holding?.task.task_id ?? null,
        item: holding?.item.id ?? null,
        epoch: holding?.item.lease?.epoch ?? null,
        observed_main: state.tip,
        runtime: "native",
      });
      this.lastBeatMonoMs = this.clock.monotonicMs();
    }
  }
}

export interface SimWorldOptions {
  seed: number | string;
  devices: readonly (string | SimDeviceOptions)[];
  /** Parent for a fresh owned temp directory. Defaults to the repository's ignored scratch dir. */
  root?: string;
  codeHost?: SimCodeHost;
}

export class SimWorld {
  readonly nodes: SimNode[] = [];
  readonly rng: Rng;
  readonly time = new VirtualTime(START_MS);
  readonly scheduler: SimScheduler;
  readonly clock: FakeClock;
  readonly git: GitRunner;
  readonly blackboardRemote: string;
  readonly codeRemote: string;
  readonly trustPath: string;
  readonly humanSigner: SshKeySigner;
  readonly violations: SimViolation[] = [];
  codeHost?: SimCodeHost;
  private readonly tickStops: (() => void)[] = [];

  private constructor(
    readonly root: string,
    readonly seed: number | string,
    codeHost?: SimCodeHost,
  ) {
    this.rng = new Rng(seed);
    this.scheduler = new SimScheduler(this.time, this.rng);
    this.clock = this.scheduler.clock();
    this.git = new IsolatedGitRunner(join(root, "home"));
    this.blackboardRemote = join(root, "blackboard.git");
    this.codeRemote = join(root, "code.git");
    this.trustPath = join(root, "allowed_signers");
    this.humanSigner = new SshKeySigner({ principal: "human", keyPath: join(root, "keys/human") });
    this.codeHost = codeHost;
    this.scheduler.onStep = () => this.check();
  }

  static async create(opts: SimWorldOptions): Promise<SimWorld> {
    if (
      (typeof opts.seed !== "string" && typeof opts.seed !== "number") ||
      (typeof opts.seed === "number" && !Number.isFinite(opts.seed))
    ) {
      throw new SimWorldError("Simulation seed must be a string or a finite number");
    }
    if (opts.devices.length === 0) throw new SimWorldError("Simulation needs at least one device");
    const specs = opts.devices.map((device) => (typeof device === "string" ? { device } : device));
    const agents = new Set<string>();
    for (const spec of specs) {
      if (!DEVICE_RE.test(spec.device) || spec.device.trim() !== spec.device) {
        throw new SimWorldError("Invalid simulation device name");
      }
      const agent = AgentIdSchema.parse(spec.agent ?? `${spec.device}.coding`);
      if (deviceOfAgent(agent) !== spec.device || agents.has(agent)) {
        throw new SimWorldError("Simulated agents must be unique and belong to their device");
      }
      if (spec.skewMs !== undefined && !Number.isFinite(spec.skewMs))
        throw new SimWorldError("Clock skew must be finite");
      agents.add(agent);
    }
    const parent = resolve(opts.root ?? ".skep-sim");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, "world-"));
    const world = new SimWorld(root, opts.seed, opts.codeHost);
    try {
      await world.initialize(specs);
      await world.check();
      return world;
    } catch (error) {
      await world.close();
      if (error instanceof SimInvariantError || error instanceof SimWorldError) throw error;
      throw new SimWorldError("Cannot create simulation world; check local git and test SSH keys", {
        cause: error,
      });
    }
  }

  private async initialize(specs: readonly SimDeviceOptions[]): Promise<void> {
    await mkdir(join(this.root, "home"), { mode: 0o700 });
    await writeFile(
      join(this.root, "home/gitconfig"),
      "[core]\n\thooksPath = /dev/null\n[init]\n\tdefaultBranch = main\n",
    );
    await mkdir(join(this.root, "keys"), { mode: 0o700 });
    let allowed = "";
    for (const device of ["human", ...new Set(specs.map((spec) => spec.device))]) {
      await copyFile(join(keyFixtures, device), join(this.root, "keys", device));
      await chmod(join(this.root, "keys", device), 0o600);
      const publicKey = (await readFile(join(keyFixtures, `${device}.pub`), "utf8")).trim();
      const principal = device === "human" ? "human" : `daemon:${device}`;
      allowed += `${principal} namespaces="git" ${publicKey}\n`;
    }
    await writeFile(this.trustPath, allowed, { mode: 0o600 });
    for (const dir of [this.blackboardRemote, this.codeRemote]) {
      await mkdir(dir, { mode: 0o700 });
      await this.git.run(["init", "--bare", "--initial-branch=main", "."], { cwd: dir });
    }
    const bootstrap = new BlackboardClone({
      git: this.git,
      dir: join(this.root, "human"),
      remoteUrl: this.blackboardRemote,
    });
    await createGenesis({
      git: this.git,
      clone: bootstrap,
      signer: this.humanSigner,
      allowedSignersText: allowed,
      genesis: {
        schema: "skep.genesis/v1",
        protocol_version: 1,
        reducer_version: REDUCER_VERSION,
        blackboard_id: `bb_${Buffer.from(this.rng.fork("genesis").bytes(12)).toString("hex")}`,
        created_at: isoUtc(this.clock.nowMs()),
      },
      ident: {
        name: "Human",
        email: "human@example.invalid",
        timestampSec: Math.floor(this.clock.nowMs() / 1_000),
        tz: "+0000",
      },
    });
    for (const spec of specs) {
      const agent = spec.agent ?? `${spec.device}.coding`;
      const clock = this.scheduler.clock({ skewMs: spec.skewMs });
      const bootstrapClone = new BlackboardClone({
        git: this.git,
        dir: join(this.root, "nodes", agent),
        remoteUrl: this.blackboardRemote,
      });
      await bootstrapClone.init();
      await bootstrapClone.fetch();
      const tip = await bootstrapClone.resetToRemoteMain();
      const git = new FaultyGitRunner({
        git: this.git,
        clock,
        seeded: spec.seededFaults
          ? { ...spec.seededFaults, rng: this.rng.fork(`faults:${agent}`) }
          : undefined,
      });
      const signer = new SshKeySigner({
        principal: `daemon:${spec.device}`,
        keyPath: join(this.root, "keys", spec.device),
      });
      const clone = new BlackboardClone({
        git,
        dir: join(this.root, "nodes", agent),
        remoteUrl: this.blackboardRemote,
      });
      const trustPath = join(clone.dir, "allowed_signers");
      await writeFile(trustPath, allowed, { mode: 0o600 });
      const hints = new NullHintChannel();
      const sync = new Sync({
        git,
        clone,
        trustPath,
        clock,
        hints,
        rng: rngRandomSource(this.rng.fork(`sync:${agent}`)),
      });
      // Bootstrap must succeed before faults are armed; scripted occurrences start at node tick 1.
      await sync.replayTo(tip);
      const publisher = new Publisher({
        git,
        clone,
        signer,
        clock,
        state: sync,
        rng: rngRandomSource(this.rng.fork(`publisher:${agent}`)),
        ident: {
          name: "Skep Daemon",
          email: "skepd@example.invalid",
          timestampSec: 0,
          tz: "+0000",
        },
      });
      const alarms: DuplicateDaemonError[] = [];
      const heartbeat = new HeartbeatWriter({
        git,
        repoDir: clone.dir,
        agent,
        signer,
        clock,
        bootId: `b_${Buffer.from(this.rng.fork(`boot:${agent}`).bytes(8)).toString("hex")}`,
        onAlarm: (alarm) => alarms.push(alarm),
      });
      const node = new SimNode(
        spec.device,
        agent,
        git,
        clone,
        sync,
        publisher,
        heartbeat,
        clock,
        trustPath,
        hints,
        alarms,
        spec.duties,
      );
      this.nodes.push(node);
      for (const rule of spec.faults ?? []) git.inject(rule);
    }
  }

  node(deviceOrAgent: string): SimNode {
    const node = this.nodes.find(
      (entry) => entry.agent === deviceOrAgent || entry.device === deviceOrAgent,
    );
    if (!node) throw new SimWorldError(`No simulated node named ${deviceOrAgent}`);
    return node;
  }

  startTicks(intervalMs = 60_000): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
      throw new SimWorldError("Tick interval must be positive and finite");
    if (this.tickStops.length > 0)
      throw new SimWorldError("Simulation ticks are already scheduled");
    for (const node of this.nodes) {
      let stopped = false;
      let cancel: () => void = () => {};
      const schedule = (at: number) => {
        cancel = this.scheduler.schedule(
          at,
          `tick:${node.agent}`,
          async () => {
            await node.tick();
            if (!stopped) schedule(this.time.now + intervalMs);
          },
          () => !node.clock.suspended,
        );
      };
      schedule(this.time.now);
      this.tickStops.push(() => {
        stopped = true;
        cancel();
      });
    }
  }

  async publishHuman(intent: Intent, deviceOrAgent = this.nodes[0]?.agent): Promise<PublishResult> {
    if (!deviceOrAgent) throw new SimWorldError("A human publisher needs a simulation node");
    return this.scheduler.execute(() =>
      this.node(deviceOrAgent).publisher.publish(intent, { signer: this.humanSigner }),
    );
  }

  async check(): Promise<void> {
    const violations = await checkWorldInvariants(this);
    this.violations.push(...violations);
    if (violations.length > 0) throw new SimInvariantError(violations);
  }

  async finalTip(): Promise<Sha> {
    return ShaSchema.parse(
      (
        await this.git.run(["rev-parse", "refs/heads/main"], { cwd: this.blackboardRemote })
      ).stdout.trim(),
    );
  }

  async run(steps: number): Promise<void> {
    if (!Number.isSafeInteger(steps) || steps < 0)
      throw new SimWorldError("Step limit must be a non-negative safe integer");
    const until = this.scheduler.steps + steps;
    while (this.scheduler.steps < until && (await this.scheduler.step())) {
      /* bounded by steps */
    }
  }

  async close(): Promise<void> {
    for (const stop of this.tickStops.splice(0)) stop();
    for (const node of this.nodes) {
      await node.sync.stop();
      await node.hints.stop();
    }
    await rm(this.root, { recursive: true, force: true });
  }
}
