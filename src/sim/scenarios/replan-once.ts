import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter } from "../../adapter/fake.js";
import { canonicalJson, sha256Hex } from "../../core/canonical.js";
import { checkpointIntent, claimIntent } from "../../core/intents.js";
import type { CommandRunEvidence } from "../../core/schemas/evidence.js";
import { SnapshotSchema } from "../../core/schemas/snapshot.js";
import { attemptReplanHandler } from "../../daemon/duties.js";
import { createReplanDuty, publishReplanRequest } from "../../daemon/replan.js";
import { SlotRegistry } from "../../daemon/slots.js";
import { AttemptRunner } from "../../exec/attempt.js";
import { EvidenceVerifier } from "../../exec/evidence.js";
import { Journal } from "../../exec/journal.js";
import { Redactor } from "../../exec/redact.js";
import { CodeMirror } from "../../exec/worktree.js";
import type { GitRunner } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import { reverify } from "../../lease/reverify.js";
import type { ProcessExit, RuntimeBackend } from "../../runtime/types.js";
import { rngRandomSource } from "../rng.js";
import type { SimWorld } from "../world.js";
import {
  approvePlan,
  converge,
  ITEM,
  prepareTask,
  publish,
  REPO,
  requireScenario,
  TASK,
} from "./claim-race.js";
import type { Scenario } from "./index.js";

/** Shared production replan driver; the human alone approves replacement plans. */
export async function replanScenario(
  world: SimWorld,
  rounds: number,
  missing = false,
  agentOriginated = false,
): Promise<void> {
  const code = await prepareTask(world, "vps.coding", "mac.coding");
  const owner = world.node("mac");
  const holder = world.node("vps");
  const redactor = new Redactor();
  const notifications: string[] = [];
  const codeGit: GitRunner = {
    run: (args, opts) =>
      world.git.run(
        args.map((arg) => (arg === REPO ? world.codeRemote : arg)),
        opts,
      ),
  };
  const roles = new Map<string, Awaited<ReturnType<SlotRegistry["start"]>>>();
  const journals = new Map<string, Journal>();
  const editAdapter = new FakeAdapter({
    clock: holder.clock,
    seed: world.seed,
    version: "0.0.0-test",
    scripts: { work: { kind: "success", files: ["example.txt"] } },
  });
  for (const node of world.nodes) {
    const roleDir = join(world.root, "roles", node.agent);
    const agentHome = join(world.root, "agents", node.agent);
    await mkdir(agentHome, { recursive: true });
    const slots = new SlotRegistry({
      device: node.device,
      adapter: () => editAdapter,
      resolveUser: async () => ({}),
      loadPolicy: async () => ({
        file: join(roleDir, "AGENT.md"),
        body: "Implement the assigned example item.",
        frontMatter: {
          schema: "skep.agent/v1",
          role: "coding",
          agent_cli: "codex",
          cli_version: "0.0.0-test",
          repos: [REPO],
          capabilities: [],
          requires_local: [],
          max_parallel_items: 1,
          budgets: { max_invocation_minutes: 30 },
        },
      }),
    });
    const slot = await slots.start({
      roleDir,
      home: agentHome,
      user: "skep",
      path: process.env.PATH ?? "",
    });
    roles.set(node.agent, slot);
    journals.set(node.agent, new Journal({ roleDir, clock: node.clock, redactor }));
  }
  const holderSlot = roles.get(holder.agent);
  const journal = journals.get(holder.agent);
  const ownerJournal = journals.get(owner.agent);
  requireScenario(world, holderSlot && journal && ownerJournal, "Missing local replan services");
  const mirror = new CodeMirror({
    git: codeGit,
    home: join(world.root, "code", holder.agent),
    repos: [{ name: "code", url: REPO }],
    worktreeRoot: join(holderSlot.roleDir, ".skep/worktrees"),
  });
  await mirror.fetch(REPO);
  const verifier = new EvidenceVerifier({ git: codeGit, mirror, journal: ownerJournal });
  let finish = false;
  let invocationReady = () => {};
  let outputReady = () => {};
  const finalOutput = new Promise<void>((resolve) => {
    outputReady = resolve;
  });
  let round = 0;
  const signals: string[] = [];
  const runtime: RuntimeBackend = {
    name: "native",
    isAlive: async () => true,
    spawn: async () => {
      let exit!: (value: ProcessExit) => void;
      const done = new Promise<ProcessExit>((resolve) => {
        exit = resolve;
      });
      const stopsAt = round === 1 ? "SIGINT" : round === 2 ? "SIGTERM" : "SIGKILL";
      return {
        pid: 100 + round,
        pgid: 100 + round,
        startToken: `example-start-${round}`,
        wait: () => done,
        signalGroup: (signal) => {
          signals.push(signal);
          if (signal === stopsAt) exit({ code: null, signal });
        },
      };
    },
  };
  const attempt = new AttemptRunner({
    mirror,
    git: codeGit,
    signer: new SshKeySigner({ principal: "daemon:vps", keyPath: join(world.root, "keys/vps") }),
    ident: { name: "Skep Daemon", email: "skepd@example.invalid", tz: "+0000" },
    agentEnv: holderSlot.envOptions,
    runtime,
    adapter: (backend, interrupt) => ({
      cli: "codex",
      probe: editAdapter.probe.bind(editAdapter),
      invoke: async (inv) => {
        const result = await editAdapter.invoke(inv);
        if (finish) {
          outputReady();
          return result;
        }
        if (agentOriginated) {
          const text = await codeGit.run(["show", `${code.base}:example.txt`], {
            cwd: await mirror.mirrorPath(REPO),
          });
          const excerpt = text.stdout.split("\n")[0] ?? "";
          invocationReady();
          return {
            ...result,
            finalMessage: JSON.stringify({
              ...JSON.parse(result.finalMessage ?? "null"),
              replan_request: {
                summary: "Revise the plan using the pinned example file.",
                evidence: [
                  {
                    id: "ev_agent_file",
                    type: "file_span",
                    repo: REPO,
                    commit: code.base,
                    path: "example.txt",
                    lines: [1, 1],
                    sha256: sha256Hex(excerpt),
                    excerpt,
                  },
                ],
              },
            }),
          };
        }
        const handle = await backend.spawn({
          argv: ["example-agent"],
          cwd: inv.cwd,
          env: inv.env,
          logPath: inv.logPath,
        });
        invocationReady();
        try {
          await holder.clock.sleep(30 * 60_000, inv.signal);
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError" && inv.signal.aborted))
            throw error;
          // Compress process grace delays so capture polling does not dominate the seed sweep.
          // The production defaults are covered by exec/interrupt.test.ts; the deadline stays 20 min.
          const state = await interrupt(handle, holder.clock, { graceMs: 120, termMs: 30 });
          return { ...result, outcome: state, exitCode: null, finalMessage: null };
        }
        throw new Error("Replan scenario never interrupted its invocation");
      },
    }),
    checks: {
      load: async () => ({ schema: "skep.checks/v1", checks: {} }),
      run: async () => [],
    },
    scanSecrets: async () => ({ status: "clean" }),
    redactor,
    codeHost: code.host,
    reverify: (lease) => reverify(holder.sync, lease),
    publisher: holder.publisher,
    journal,
    clock: holder.clock,
    random: rngRandomSource(world.rng.fork("replan-attempt")),
    scratchDir: join(world.root, "scratch"),
  });
  for (const node of world.nodes) {
    const duty = createReplanDuty({
      clock: node.clock,
      journal: (slot) => {
        const local = journals.get(slot.agent);
        requireScenario(world, local, "Missing replan journal");
        return local;
      },
      notify: async (message) => {
        notifications.push(message);
      },
    });
    node.duties = async (_node, state) => {
      const task = state.tasks[TASK];
      const slot = roles.get(node.agent);
      requireScenario(world, task && slot, "Missing replan duty context");
      await duty({
        state,
        task,
        slot,
        nowMonoMs: node.clock.monotonicMs(),
        publisher: node.publisher,
        attempt,
      });
      return [];
    };
  }
  const start = world.time.now;
  for (let index = 0; index < rounds; index++) {
    const at = start + index * 6 * 60_000;
    let ready!: () => void;
    const launched = new Promise<void>((resolve) => {
      ready = resolve;
    });
    world.scheduler.schedule(at, `attempt-${index + 1}`, async () => {
      round = index + 1;
      invocationReady = ready;
      await publish(
        world,
        holder,
        claimIntent({
          task_id: TASK,
          actor: holder.agent,
          item: ITEM,
          attempt_id: `att_replan${round}`,
        }),
      );
      if (missing) {
        holder.clock.suspend();
        return;
      }
      const task = holder.state.tasks[TASK];
      const lease = task?.items[ITEM]?.lease;
      const plan = task?.plans[String(task.active_plan_version)]?.plan;
      requireScenario(world, task && lease && plan, "Replan attempt has no approved lease");
      const result = await attempt.run(
        {
          lease: { task_id: TASK, item: ITEM, epoch: lease.epoch, holder: holder.agent },
          attemptId: lease.attempt_id,
          plan,
          baseSha: code.base,
          prBase: "main",
          agentInstructions: holderSlot.policy.body,
          repoContext: "",
          timeoutMs: 30 * 60_000,
          cliVersion: "0.0.0-test",
        },
        undefined,
        agentOriginated
          ? attemptReplanHandler(
              {
                publisher: holder.publisher,
                current: () => holder.state,
                clock: holder.clock,
                attempt: () => attempt,
                wake: () => {},
              },
              holderSlot,
              task,
              ITEM,
            )
          : undefined,
      );
      requireScenario(world, result.status === "checkpointed", "Interrupt did not checkpoint");
      requireScenario(
        world,
        result.snapshot.pushed && result.snapshot.head_sha,
        "Checkpoint was published before its WIP push",
      );
      requireScenario(
        world,
        result.snapshot.files_changed.includes("example.txt"),
        "Mechanical snapshot lost partial edits",
      );
      requireScenario(
        world,
        (await code.host.remoteBranchSha(REPO, lease.branch)) === result.snapshot.head_sha,
        "WIP remote does not match the checkpoint",
      );
    });
    world.scheduler.schedule(at + 1, `verified-replan-${index + 1}`, async () => {
      if (!missing) await launched;
      if (agentOriginated) return;
      const state = await owner.sync.observeNow();
      const task = state.tasks[TASK];
      requireScenario(world, task, "Missing replan task");
      const argv = ["show", `${code.base}:missing.txt`];
      const run = await codeGit.run(argv, {
        cwd: await mirror.mirrorPath(REPO),
        allowFailure: true,
      });
      const evidence: CommandRunEvidence = {
        id: `ev_replan_${index + 1}`,
        type: "command_run",
        run_id: `run_replan_${index + 1}`,
        sha: code.base,
        argv_sha256: sha256Hex(canonicalJson(argv)),
        exit: run.code,
        log_sha256: sha256Hex(run.stdout + run.stderr),
      };
      const { id: _id, type: _type, ...facts } = evidence;
      await ownerJournal.append(
        { task: TASK, item: ITEM, epoch: index + 1 },
        { step: "command_run", ...facts },
      );
      const reportAdapter = new FakeAdapter({
        clock: owner.clock,
        seed: world.seed,
        scripts: { work: { kind: "replanRequest", evidence: [evidence] } },
      });
      const report = await reportAdapter.invoke({
        kind: "work",
        cwd: owner.clone.dir,
        prompt: "Report the missing example file.",
        outputSchema: {},
        timeoutMs: 60_000,
        env: {},
        logPath: "unused",
        scratchDir: "unused",
        signal: new AbortController().signal,
      });
      await publishReplanRequest(
        {
          task,
          actor: owner.agent,
          item: null,
          evidenceKey: { task: TASK, item: ITEM, epoch: index + 1 },
          report: JSON.parse(report.finalMessage ?? "null"),
        },
        { verifier, publisher: owner.publisher },
      );
      requireScenario(
        world,
        owner.state.tasks[TASK]?.status === "interrupting",
        "Request did not open a barrier",
      );
      requireScenario(
        world,
        claimIntent({
          task_id: TASK,
          actor: holder.agent,
          item: ITEM,
          attempt_id: "att_blocked",
        })(owner.state) === null,
        "Barrier allowed a claim",
      );
      await owner.tick();
      if (!missing) await holder.tick();
    });
    if (!missing)
      world.scheduler.schedule(at + 5 * 60_000, `settled-replan-${index + 1}`, async () => {
        const state = await converge(world);
        const task = state.tasks[TASK];
        requireScenario(
          world,
          task?.replan_count === index + 1 && task.barrier?.closed_seq !== null,
          "Barrier did not settle exactly once",
        );
        requireScenario(
          world,
          task.items[ITEM]?.status === "interrupted",
          "Checkpoint did not park its lease",
        );
        if (index === 2) {
          requireScenario(
            world,
            task.status === "escalated" && task.escalation?.reason === "replans",
            "Third replan did not escalate",
          );
          await owner.tick();
          requireScenario(
            world,
            notifications.length === 1,
            "Owner did not notify about escalation",
          );
          requireScenario(
            world,
            signals.join(",") === "SIGINT,SIGINT,SIGTERM,SIGINT,SIGTERM,SIGKILL",
            "Scenario did not exercise the interrupt ladder",
          );
        } else {
          const head = task.items[ITEM]?.last_checkpoint?.head_sha;
          requireScenario(world, head, "Replacement plan has no checkpoint base");
          // PRD §9.7: the human approves the WIP SHA as the replacement base, preserving edits.
          code.base = head;
          await approvePlan(world, code, holder.agent);
        }
      });
  }
  if (missing) {
    world.scheduler.schedule(start + 21 * 60_000, "barrier-deadline", async () => {
      await owner.tick();
      const task = owner.state.tasks[TASK];
      requireScenario(
        world,
        task?.status === "replanning" &&
          task.items[ITEM]?.status === "unknown" &&
          task.items[ITEM]?.lease === null,
        "Deadline did not fence the missing holder",
      );
      holder.clock.resume();
      await converge(world);
      const snapshot = SnapshotSchema.parse({
        schema: "skep.snapshot/v1",
        item: ITEM,
        epoch: 1,
        attempt_id: "att_replan1",
        branch: `skep/${TASK}/${ITEM}/e1`,
        base_sha: code.base,
        head_sha: null,
        pushed: false,
        invocation_state: "unknown",
        diffstat: { files: 0, insertions: 0, deletions: 0 },
        files_changed: [],
        check_runs: [],
        agent_note: null,
      });
      requireScenario(
        world,
        checkpointIntent({
          task_id: TASK,
          actor: holder.agent,
          item: ITEM,
          epoch: 1,
          barrier_id: task.barrier?.id ?? null,
          snapshot,
        })(holder.state) === null,
        "Late checkpoint was not fenced",
      );
    });
  } else if (rounds === 1) {
    // Keep virtual time fixed while the process-free adapter completes its real file writes.
    // Otherwise the scheduler can advance its invocation timeout before those writes finish.
    world.scheduler.schedule(start + 6 * 60_000 + 1, "delivery-output-ready", () => finalOutput);
    world.scheduler.schedule(start + 6 * 60_000, "resume-higher-epoch", async () => {
      finish = true;
      await publish(
        world,
        holder,
        claimIntent({ task_id: TASK, actor: holder.agent, item: ITEM, attempt_id: "att_resumed" }),
      );
      const task = holder.state.tasks[TASK];
      const lease = task?.items[ITEM]?.lease;
      const plan = task?.plans[String(task.active_plan_version)]?.plan;
      requireScenario(
        world,
        lease?.epoch === 2 && plan?.version === 2,
        "Replan lost plan/epoch fencing",
      );
      const result = await attempt.run({
        lease: { task_id: TASK, item: ITEM, epoch: 2, holder: holder.agent },
        attemptId: lease.attempt_id,
        plan,
        baseSha: code.base,
        prBase: "main",
        agentInstructions: holderSlot.policy.body,
        repoContext: "",
        timeoutMs: 60_000,
      });
      requireScenario(world, result.status === "delivered", "Approved replacement did not deliver");
      await converge(world);
    });
  }
}

export const replanOnce: Scenario = {
  name: "replan-once",
  devices: ["mac", "vps"],
  steps: 22,
  setup: (world) => replanScenario(world, 1),
};

/** S3 variant: the running agent's report opens the barrier through the production callback. */
export const agentReplanOnce: Scenario = {
  name: "agent-replan-once",
  devices: ["mac", "vps"],
  steps: 22,
  setup: (world) => replanScenario(world, 1, false, true),
};
