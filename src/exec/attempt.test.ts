import { appendFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import {
  agentRegistered,
  fakeEventId,
  LogBuilder,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { FakeAdapter, type FakeScript } from "../adapter/fake.js";
import type { PublishResult } from "../blackboard/publisher.js";
import { FakeCodeHost } from "../codehost/fake.js";
import { sha256Hex } from "../core/canonical.js";
import { workBranch } from "../core/ids.js";
import type { Intent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import { attemptReplanHandler } from "../daemon/duties.js";
import type { Slot } from "../daemon/slots.js";
import { NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import type { ProcessExit, RuntimeBackend } from "../runtime/types.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { systemClock } from "../util/clock.js";
import {
  AttemptError,
  type AttemptInput,
  AttemptRunner,
  type AttemptRunnerDependencies,
} from "./attempt.js";
import { ChecksRunner } from "./checks.js";
import { type AttemptKey, Journal } from "./journal.js";
import { Redactor } from "./redact.js";
import type { scanSecrets } from "./secret-scan.js";
import { CodeMirror } from "./worktree.js";

const key: AttemptKey = { task: T1, item: "W1", epoch: 1 };
const branch = workBranch(T1, "W1", 1);
const report = {
  schema: "skep.work_report/v1",
  summary: "Example change",
  files_intended: ["result.txt"],
  concerns: [],
  replan_request: null,
};
const secret = `sk-${"A".repeat(24)}`;
const secretFailureDetail = "Secret scan blocked publication; see the local journal";

describe("journaled attempt pipeline", () => {
  const git = new NodeGitRunner();
  let root: string;
  let remote: string;
  let mirror: CodeMirror;
  let journal: Journal;
  let host: FakeCodeHost;
  let adapter: FakeAdapter;
  let input: AttemptInput;
  let deps: AttemptRunnerDependencies;
  let log: LogBuilder;
  let checksRuntime: RuntimeBackend;
  let checkCounter: number;
  let scanner: ReturnType<typeof vi.fn<typeof scanSecrets>>;
  let publish: ReturnType<typeof vi.fn<AttemptRunnerDependencies["publisher"]["publish"]>>;

  beforeEach(async () => {
    root = await tempDir("attempt-");
    vi.stubEnv("HOME", root);
    vi.stubEnv("SKEP_HOME", join(root, "home"));
    remote = join(root, "remote.git");
    const writer = join(root, "writer");
    await initRepo(remote, { bare: true });
    await initRepo(writer);
    await commitFile(git, writer, "result.txt", "base\n");
    const base = await commitFile(
      git,
      writer,
      ".skep/checks.toml",
      'schema = "skep.checks/v1"\n[checks.unit]\nargv = ["example-check"]\nparser = "tap"\n',
    );
    await git.run(["push", remote, `${base}:refs/heads/main`], { cwd: writer });
    const plan = samplePlan({ base: { repo: "app", branch: "main", commit: base } });
    plan.base = { repo: "app", branch: "main", commit: base };
    required(plan.items[0]).acceptance = [{ kind: "check", name: "unit" }];
    input = {
      lease: { task_id: T1, item: "W1", epoch: 1, holder: VPS },
      attemptId: "att_aabbccddeeff",
      plan,
      baseSha: base,
      prBase: "main",
      submit: { method: "pr", host: "github" },
      agentInstructions: "Implement the example item.",
      repoContext: "Example repository.",
      timeoutMs: 10000,
    };
    mirror = new CodeMirror({
      git,
      home: join(root, "home"),
      worktreeRoot: join(root, "worktrees"),
      repos: [{ name: "app", url: remote }],
    });
    const redactor = new Redactor();
    // The runner also scrubs, so even a journal with no configured redactor must remain safe.
    journal = new Journal({ roleDir: join(root, "role"), clock: systemClock });
    host = new FakeCodeHost({ git, repo: "app", repoDir: remote });
    adapter = fake({
      work: { kind: "success", files: [{ path: "result.txt", content: "good\n" }] },
    });
    log = new LogBuilder();
    log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    log.append({
      type: "task.created",
      task_id: T1,
      actor: "human",
      payload: {
        ...taskCreated({ repo: "app", title: "Example task", body: "Implement the example item." }),
        repo: "app",
      },
    });
    log.append({
      type: "plan.proposed",
      task_id: T1,
      actor: VPS,
      pre: { task_rev: 1, owner_gen: 1 },
      payload: planProposed(plan),
    });
    log.append({
      type: "plan.approved",
      task_id: T1,
      actor: "human",
      pre: { task_rev: 2, plan_version: 1, plan_hash: planProposed(plan).plan_hash },
      payload: { plan_version: 1, plan_hash: planProposed(plan).plan_hash },
    });
    log.append({
      type: "lease.claimed",
      task_id: T1,
      actor: VPS,
      pre: {
        task_rev: 3,
        plan_version: 1,
        plan_hash: planProposed(plan).plan_hash,
        item: "W1",
        expected_epoch: 0,
      },
      payload: { item: "W1", attempt_id: input.attemptId, branch },
    });
    expect(replay(log.entries).tasks[T1]?.items.W1?.status).toBe("leased");
    publish = vi.fn(
      async (intent: Intent, options?: { eventId?: string }): Promise<PublishResult> => {
        const state = replay(log.entries);
        const eventId = options?.eventId;
        if (!eventId) throw new Error("The event id must be persisted before publishing");
        const seen = state.seen_event_ids[eventId];
        if (seen !== undefined) return { status: "accepted", eventId, seq: seen };
        const event = intent(state);
        if (!event) return { status: "dropped", eventId };
        expect(JSON.stringify(event)).not.toContain(secret);
        const records = await journal.read(key);
        if (event.type === "replan.requested") {
          expect(records.findLast((entry) => entry.step === "replan_pending")).toMatchObject({
            event_id: eventId,
          });
        } else {
          expect(
            records.findLast((entry) => entry.step === "publish_pending")?.publication,
          ).toMatchObject({ event_id: eventId });
        }
        if (event.type === "work.delivered") {
          const payload = event.payload as { head_sha: string; submit: { method: string } };
          if (["pr", "mr"].includes(payload.submit.method))
            expect(await host.remoteBranchSha("app", branch)).toBe(payload.head_sha);
        }
        log.append({
          type: event.type,
          task_id: event.task_id,
          actor: event.actor,
          payload: event.payload,
          pre: event.pre,
          event_id: eventId,
        });
        const outcome = required(replay(log.entries).outcomes.at(-1));
        expect(outcome.outcome, outcome.reason ?? "").toBe("accepted");
        return { status: "accepted", seq: outcome.seq, eventId };
      },
    );
    checkCounter = 0;
    checksRuntime = {
      name: "native",
      isAlive: async () => false,
      spawn: vi.fn(async (options) => {
        checkCounter += 1;
        const good = (await readFile(join(options.cwd, "result.txt"), "utf8")).startsWith("good");
        await writeFile(options.logPath, good ? "ok 1 - example\n" : "not ok 1 - example\n");
        return {
          pid: 200 + checkCounter,
          pgid: 200 + checkCounter,
          startToken: `check-${checkCounter}`,
          wait: async () => ({ code: good ? 0 : 1, signal: null }),
          signalGroup: vi.fn(),
        };
      }),
    };
    scanner = vi.fn(async (options, dependencies) => {
      const dir = await dependencies.mirror.mirrorPath(options.repo);
      expect(
        (
          await dependencies.git.run(["cat-file", "-t", options.baseSha], { cwd: dir })
        ).stdout.trim(),
      ).toBe("commit");
      expect(options.env.agentCli).toBeUndefined();
      expect(options.env.configDir).toBeUndefined();
      return { status: "clean" };
    });
    const env = {
      home: root,
      user: "agent",
      source: {
        PATH: "example-bin",
        GH_TOKEN: "blocked",
        OPENAI_API_KEY: "blocked",
        SSH_AUTH_SOCK: "blocked",
      },
    };
    const keyPath = join(root, "vps-key");
    await writeFile(
      keyPath,
      await readFile(fileURLToPath(new URL("../../test/fixtures/keys/vps", import.meta.url))),
      { mode: 0o600 },
    );
    const checks = new ChecksRunner({
      git,
      mirror,
      journal,
      clock: systemClock,
      env,
      runtime: checksRuntime,
    });
    deps = {
      git,
      mirror,
      journal,
      clock: systemClock,
      codeHost: host,
      adapter,
      checks,
      signer: new SshKeySigner({
        principal: "daemon:vps",
        keyPath,
      }),
      ident: { name: "skepd", email: "daemon@example.invalid", tz: "+0000" },
      agentEnv: env,
      redactor,
      scratchDir: join(root, "scratch"),
      scanSecrets: scanner,
      reverify: vi.fn(async () => "ok" as const),
      publisher: { publish },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function fake(
    scripts: Partial<Record<"work" | "fixup" | "repair", FakeScript | readonly FakeScript[]>>,
  ) {
    return new FakeAdapter({ clock: systemClock, seed: 1, scripts });
  }
  const run = () => new AttemptRunner(deps).run(input);
  const worktree = () => join(mirror.worktreeRoot, T1, "W1-e1");

  const requestReport = () => ({
    ...report,
    replan_request: {
      summary: "Revise the example plan.",
      evidence: [
        {
          id: "ev_file",
          type: "file_span",
          repo: "app",
          commit: input.baseSha,
          path: "result.txt",
          lines: [1, 1],
          sha256: sha256Hex("base"),
          excerpt: "base",
        },
      ],
    },
  });
  function replanHandler(runner: AttemptRunner) {
    return attemptReplanHandler(
      {
        publisher: deps.publisher,
        current: () => replay(log.entries),
        clock: deps.clock,
        attempt: () => runner,
        wake: () => {},
      },
      { agent: VPS, roleDir: join(root, "role") } as Slot,
      required(replay(log.entries).tasks[T1]),
      "W1",
    );
  }

  it.each(["work", "fixup"] as const)(
    "checkpoints a verified %s request before delivery",
    async (phase) => {
      deps.adapter = adapter = fake({
        work: {
          kind: "success",
          files: [{ path: "result.txt", content: phase === "work" ? "good\n" : "bad\n" }],
          output: phase === "work" ? requestReport() : report,
        },
        fixup: { kind: "success", output: requestReport() },
      });
      const runner = new AttemptRunner(deps);
      const result = await runner.run(input, undefined, replanHandler(runner));
      expect(result).toMatchObject({
        status: "checkpointed",
        snapshot: { pushed: true, invocation_state: "completed" },
      });
      expect(checkCounter).toBe(phase === "work" ? 0 : 1);
      expect(await host.findPr("app", branch)).toBeNull();
      expect(log.events.filter((event) => event?.type === "replan.requested")).toHaveLength(1);
      expect(log.events.some((event) => event?.type === "work.delivered")).toBe(false);
      const task = required(replay(log.entries).tasks[T1]);
      expect(task).toMatchObject({ status: "replanning", replan_count: 1 });
      expect(log.events.at(-1)).toMatchObject({
        type: "checkpoint.recorded",
        payload: { barrier_id: task.barrier?.id },
      });
      expect(
        (await journal.read(key)).some((record) => record.step === "interrupt_requested"),
      ).toBe(true);
    },
  );

  it.each(["work", "fixup"] as const)(
    "journals an unverified %s request and continues delivery",
    async (phase) => {
      const ignored = requestReport();
      required(ignored.replan_request.evidence[0]).sha256 = "0".repeat(64);
      deps.adapter = fake({
        work: {
          kind: "success",
          files: [{ path: "result.txt", content: phase === "work" ? "good\n" : "bad\n" }],
          output: phase === "work" ? ignored : report,
        },
        fixup: {
          kind: "success",
          files: [{ path: "result.txt", content: "good\n" }],
          output: ignored,
        },
      });
      const runner = new AttemptRunner(deps);
      expect(await runner.run(input, undefined, replanHandler(runner))).toMatchObject({
        status: "delivered",
      });
      expect(log.events.some((event) => event?.type === "replan.requested")).toBe(false);
      expect(
        (await journal.read(key)).find((record) => record.step === "replan_ignored"),
      ).toMatchObject({
        phase,
        message: "replan request ignored",
        reason: "no_verified_evidence",
      });
    },
  );

  it("retains the request event id after a lost acknowledgement and never delivers", async () => {
    deps.adapter = adapter = fake({ work: { kind: "success", output: requestReport() } });
    let lostAck = true;
    deps.publisher = {
      publish: async (intent, options) => {
        const outcome = await publish(intent, options);
        if (lostAck && log.events.at(-1)?.type === "replan.requested") {
          lostAck = false;
          return { status: "failed", eventId: outcome.eventId, reason: "lost acknowledgement" };
        }
        return outcome;
      },
    };
    const runner = new AttemptRunner(deps);
    const handler = replanHandler(runner);
    expect(await runner.run(input, undefined, handler)).toMatchObject({ status: "pending" });
    expect(checkCounter).toBe(0);
    expect(await host.findPr("app", branch)).toBeNull();
    expect(await runner.run(input, undefined, handler)).toMatchObject({ status: "checkpointed" });
    expect(adapter.invocations).toHaveLength(1);
    expect(log.events.filter((event) => event?.type === "replan.requested")).toHaveLength(1);
    expect(
      (await journal.read(key)).filter((record) => record.step === "replan_pending"),
    ).toHaveLength(1);
  });

  it("does not deliver when its replan handler is missing or its request is fenced", async () => {
    deps.adapter = fake({ work: { kind: "success", output: requestReport() } });
    const runner = new AttemptRunner(deps);
    await expect(runner.run(input)).rejects.toThrow("configure its handler");
    expect(
      await runner.run(input, undefined, async () => ({ status: "dropped", reason: "stale" })),
    ).toEqual({ status: "stale" });
    expect(checkCounter).toBe(0);
    expect(await host.findPr("app", branch)).toBeNull();
    expect(log.events.some((event) => event?.type === "work.delivered")).toBe(false);
  });

  it.each([
    ["pr", "opened", true, true],
    ["mr", "opened", true, true],
    ["push", "pushed", true, false],
    ["none", "local", false, false],
    ["ask", "pending", false, false],
  ] as const)(
    "delivers %s with the correct Git and code-host operations",
    async (method, state, pushed, opened) => {
      input.submit = { method, host: method === "mr" ? "gitlab" : "github" };
      const ports = [
        "remoteBranchSha",
        "findPr",
        "createPr",
        "prState",
        "retargetPr",
        "closePr",
      ] as const;
      const spies = ports.map((port) => vi.spyOn(host, port));
      const gitRun = vi.spyOn(git, "run");
      expect(await run()).toMatchObject({ status: "delivered" });
      const delivery = log.events.findLast((event) => event?.type === "work.delivered");
      expect(delivery).toMatchObject({ payload: { submit: { method, state } } });
      const pushes = gitRun.mock.calls.filter(([argv]) => argv.includes("push"));
      expect(pushes).toHaveLength(pushed ? 1 : 0);
      if (pushed) expect(pushes[0]?.[0].at(-1)).toMatch(new RegExp(`:refs/heads/${branch}$`));
      if (!opened) for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      else expect(spies[2]).toHaveBeenCalledOnce();
      expect((await journal.read(key)).some((record) => record.step === "pr")).toBe(opened);
    },
  );

  it.each(["none", "ask"] as const)(
    "replays pending %s delivery without pushing or touching the code host",
    async (method) => {
      input.submit = { method, host: "github" };
      for (const port of [
        "remoteBranchSha",
        "findPr",
        "createPr",
        "prState",
        "retargetPr",
        "closePr",
      ] as const)
        vi.spyOn(host, port).mockRejectedValue(new Error("Code host must stay unused"));
      const gitRun = vi.spyOn(git, "run");
      publish.mockResolvedValueOnce({
        status: "failed",
        eventId: fakeEventId(999),
        reason: "outage",
      });
      expect(await run()).toMatchObject({ status: "pending" });
      expect(await run()).toMatchObject({ status: "delivered" });
      expect(gitRun.mock.calls.some(([argv]) => argv.includes("push"))).toBe(false);
      expect(adapter.invocations).toHaveLength(1);
      expect(
        (await journal.read(key)).filter((record) => record.step === "publish_pending"),
      ).toHaveLength(1);
    },
  );

  it.each(["pr", "mr"] as const)(
    "uses a Git-only host as push for requested %s",
    async (method) => {
      input.submit = { method, host: "git" };
      const create = vi.spyOn(host, "createPr");
      expect(await run()).toMatchObject({ status: "delivered" });
      expect(create).not.toHaveBeenCalled();
      expect(log.events.at(-1)).toMatchObject({
        payload: { submit: { method: "push", state: "pushed" } },
      });
      expect((await journal.read(key)).find((record) => record.step === "submit")).toMatchObject({
        reason: "git_only_host_forces_push",
      });
    },
  );

  it("rejects malformed Git ref observations before push-only submission", async () => {
    input.submit = { method: "push", host: "git" };
    const original = git.run.bind(git);
    const gitRun = vi.spyOn(git, "run").mockImplementation(async (argv, options) => {
      if (argv.includes("ls-remote"))
        return { code: 0, stdout: `invalid\trefs/heads/${branch}\n`, stderr: "" };
      return original(argv, options);
    });
    await expect(run()).rejects.toThrow("invalid epoch branch SHA");
    expect(gitRun.mock.calls.some(([argv]) => argv.includes("push"))).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["push", "pr", "none", "ask"] as const)(
    "fences %s before its first visible operation",
    async (method) => {
      input.submit = { method, host: "github" };
      deps.reverify = vi.fn(async () => "stale" as const);
      const gitRun = vi.spyOn(git, "run");
      const create = vi.spyOn(host, "createPr");
      expect(await run()).toEqual({ status: "stale" });
      expect(gitRun.mock.calls.some(([argv]) => argv.includes("push"))).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("journals the ordered happy path, signs as the daemon and publishes code first", async () => {
    expect(await run()).toMatchObject({ status: "delivered" });
    const records = await journal.read(key);
    const steps = records.map((entry) => entry.step);
    let previous = -1;
    for (const step of [
      "claimed",
      "worktree_created",
      "preflight_ok",
      "invoked",
      "invocation_done",
      "committed",
      "checks",
      "secret_scan_ok",
      "submit",
      "reverified",
      "pushed",
      "pr",
      "publish_pending",
      "delivered_published",
    ]) {
      const index = steps.indexOf(step);
      expect(index, step).toBeGreaterThan(previous);
      previous = index;
    }
    expect(
      records.filter((entry) => entry.step === "reverified").map((entry) => entry.before),
    ).toEqual(["push", "pr", "work.delivered"]);
    const head = await host.remoteBranchSha("app", branch);
    expect((await git.run(["cat-file", "-p", required(head)], { cwd: remote })).stdout).toContain(
      "gpgsig -----BEGIN SSH SIGNATURE-----",
    );
    expect(replay(log.entries).tasks[T1]?.status).toBe("delivered");
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(adapter.invocations[0]?.prompt).toContain("Do not run git");
    expect(adapter.invocations[0]?.env).toEqual({
      HOME: root,
      USER: "agent",
      LOGNAME: "agent",
      PATH: "example-bin",
    });
    expect(checksRuntime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HOME: root, USER: "agent", LOGNAME: "agent", PATH: "example-bin" },
      }),
    );
    const fetch = vi.spyOn(mirror, "fetch");
    const calls = publish.mock.calls.length;
    expect(await run()).toMatchObject({ status: "delivered" });
    expect(fetch).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(adapter.invocations).toHaveLength(1);
  });

  it("uses one fix-up with redacted check excerpts and a read-only diff, then rechecks the new SHA", async () => {
    deps.adapter = adapter = fake({
      work: { kind: "success", files: [{ path: "result.txt", content: "bad\n" }] },
      fixup: { kind: "success", files: [{ path: "result.txt", content: "good\n" }] },
    });
    const spawn = checksRuntime.spawn;
    checksRuntime.spawn = async (options) => {
      const handle = await spawn(options);
      await appendFile(options.logPath, `${secret}\n`);
      return handle;
    };
    expect(await run()).toMatchObject({ status: "delivered" });
    expect(adapter.invocations.map((inv) => inv.kind)).toEqual(["work", "fixup"]);
    expect(adapter.invocations[1]?.prompt).toContain("Read-only diff");
    expect(adapter.invocations[1]?.prompt).toContain("[REDACTED:provider-api-key]");
    expect(adapter.invocations[1]?.prompt).not.toContain(secret);
    const runs = (await journal.read(key)).filter((entry) => entry.step === "check_run");
    expect(runs.map((entry) => entry.exit)).toEqual([1, 0]);
    expect(runs[0]?.sha).not.toBe(runs[1]?.sha);
  });

  it("fails checks after exactly one unsuccessful fix-up without publishing code or a PR", async () => {
    deps.adapter = adapter = fake({
      work: { kind: "success", files: [{ path: "result.txt", content: "bad\n" }] },
      fixup: { kind: "success", files: [{ path: "result.txt", content: "bad again\n" }] },
    });
    expect(await run()).toMatchObject({ status: "failed", class: "checks_failed" });
    expect(adapter.invocations.map((inv) => inv.kind)).toEqual(["work", "fixup"]);
    expect(await host.remoteBranchSha("app", branch)).toBeNull();
    expect(await host.findPr("app", branch)).toBeNull();
    expect(log.events.at(-1)?.type).toBe("work.failed");
  });

  it.each([
    { script: { kind: "invalidJson" } as FakeScript, failure: "invalid_output" },
    { script: { kind: "crash" } as FakeScript, failure: "crash" },
    { script: { kind: "permissionPrompt" } as FakeScript, failure: "permission_prompt" },
  ])("classifies $failure and repairs only malformed JSON", async ({ script, failure }) => {
    deps.adapter = adapter = fake({ work: script, repair: { kind: "invalidJson" } });
    expect(await run()).toMatchObject({ status: "failed", class: failure });
    expect(adapter.invocations.map((inv) => inv.kind)).toEqual(
      failure === "invalid_output" ? ["work", "repair"] : ["work"],
    );
    expect(await host.remoteBranchSha("app", branch)).toBeNull();
  });

  it("fetches before loading trusted checks and fails a missing check during preflight", async () => {
    const fetch = vi.spyOn(mirror, "fetch");
    const load = vi.spyOn(deps.checks, "load");
    required(input.plan.items[0]).acceptance = [{ kind: "check", name: "missing" }];
    expect(await run()).toMatchObject({ status: "failed", class: "preflight" });
    expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(
      required(load.mock.invocationCallOrder[0]),
    );
    expect(adapter.invocations).toHaveLength(0);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("fails a pinned CLI mismatch before invocation", async () => {
    input.cliVersion = "example-cli 1";
    expect(await run()).toMatchObject({ status: "failed", class: "preflight" });
    expect(adapter.invocations).toHaveLength(0);
  });

  it.each(["pattern", "gitleaks", "model"])(
    "blocks a $0 secret and publishes only a secret-free failure event",
    async (source) => {
      if (source === "gitleaks") scanner.mockResolvedValue({ status: "secrets_detected" });
      else
        deps.adapter = fake({
          work: {
            kind: "success",
            files: [
              {
                path: "result.txt",
                content: source === "pattern" ? `good\n${secret}\n` : "good\n",
              },
            ],
            output: source === "model" ? { ...report, summary: secret } : report,
          },
        });
      expect(await run()).toMatchObject({
        status: "failed",
        class: "secret_detected",
        publication: { status: "accepted" },
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(log.events.at(-1)).toMatchObject({
        type: "work.failed",
        payload: { item: "W1", epoch: 1, class: "secret_detected", detail: secretFailureDetail },
      });
      expect(log.events.at(-1)?.payload).not.toHaveProperty("summary");
      expect(replay(log.entries).tasks[T1]?.items.W1?.lease).toBeNull();
      expect(scanner).toHaveBeenCalledTimes(source === "model" ? 0 : 1);
      expect(await host.remoteBranchSha("app", branch)).toBeNull();
      expect(await host.findPr("app", branch)).toBeNull();
      expect(await readFile(journal.path(key), "utf8")).not.toContain(secret);
    },
  );

  it("redacts journal and streamed adapter capture before durable writes", async () => {
    input.agentInstructions += `\n${secret}`;
    const invoke = adapter.invoke.bind(adapter);
    deps.adapter = {
      cli: adapter.cli,
      probe: adapter.probe.bind(adapter),
      invoke: async (inv) => {
        await writeFile(inv.logPath, `prefix ${secret.slice(0, 12)}`);
        await appendFile(inv.logPath, `${secret.slice(12)}\n`);
        expect(inv.prompt).not.toContain(secret);
        return invoke(inv);
      },
    };
    expect(await run()).toMatchObject({ status: "delivered" });
    const captured = await readFile(
      join(dirname(journal.path(key)), "adapter", "work-1.log"),
      "utf8",
    );
    expect(captured).toContain("[REDACTED:provider-api-key]");
    expect(captured).not.toContain(secret);
    expect(await readFile(journal.path(key), "utf8")).not.toContain(secret);
    expect(await readdir(deps.scratchDir)).toEqual([]);
  });

  it.each(["pending", "ambiguous acknowledgement"])(
    "recovers a secret failure after %s with the saved event id and no code rescan",
    async (failure) => {
      scanner.mockResolvedValue({ status: "secrets_detected" });
      const original = required(publish.getMockImplementation());
      publish.mockImplementationOnce(async (intent, options) => {
        const accepted =
          failure === "ambiguous acknowledgement" ? await original(intent, options) : {};
        return {
          ...accepted,
          status: "failed",
          eventId: required(options?.eventId),
          reason: "Lost acknowledgement",
        };
      });
      expect(await run()).toMatchObject({ status: "pending" });
      expect(await run()).toMatchObject({
        status: "failed",
        class: "secret_detected",
        publication: { status: "accepted" },
      });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[0]?.[1]?.eventId).toBe(publish.mock.calls[1]?.[1]?.eventId);
      expect(log.events.filter((event) => event?.type === "work.failed")).toHaveLength(1);
      expect(log.events.at(-1)?.payload).toMatchObject({
        class: "secret_detected",
        detail: secretFailureDetail,
      });
      expect(scanner).toHaveBeenCalledOnce();
      expect(adapter.invocations).toHaveLength(1);
      expect(await host.remoteBranchSha("app", branch)).toBeNull();
      expect(await host.findPr("app", branch)).toBeNull();
    },
  );

  it("checks the failure event itself for secrets even when the rejected code scan is bypassed", async () => {
    scanner.mockResolvedValue({ status: "secrets_detected" });
    publish.mockImplementationOnce(async (_intent, options) => ({
      status: "failed",
      eventId: required(options?.eventId),
    }));
    expect(await run()).toMatchObject({ status: "pending" });
    const records = await journal.read(key);
    const pending = required(records.findLast((record) => record.step === "publish_pending"));
    const publication = pending.publication as { payload: { detail: string } };
    publication.payload.detail = secret;
    await writeFile(
      journal.path(key),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await expect(run()).rejects.toThrow("Secret failure event contains unsafe metadata");
    expect(publish).toHaveBeenCalledOnce();
    expect(scanner).toHaveBeenCalledOnce();
    expect(await host.remoteBranchSha("app", branch)).toBeNull();
  });

  it("blocks secrets encoded as JSON escapes in otherwise valid model output", async () => {
    deps.adapter = {
      cli: "codex",
      probe: adapter.probe.bind(adapter),
      invoke: async () => ({
        outcome: "completed",
        exitCode: 0,
        finalMessage: JSON.stringify({ ...report, summary: secret }).replace(
          "sk-",
          "\\u0073\\u006b-",
        ),
        usage: null,
        durationMs: 1,
        pid: null,
      }),
    };
    expect(await run()).toMatchObject({
      status: "failed",
      class: "secret_detected",
      publication: { status: "accepted" },
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(log.events.at(-1)).toMatchObject({
      type: "work.failed",
      payload: { class: "secret_detected", detail: secretFailureDetail },
    });
    expect(scanner).not.toHaveBeenCalled();
    expect(await readFile(journal.path(key), "utf8")).not.toContain(secret);
  });

  it("reserves an attempt before reading its journal so concurrent slots cannot duplicate it", async () => {
    const runner = new AttemptRunner(deps);
    const first = runner.run(input);
    await expect(runner.run(input)).rejects.toThrow("already running");
    expect(await first).toMatchObject({ status: "delivered" });
    expect(adapter.invocations).toHaveLength(1);
  });

  it.each(["before PR", "before delivery"])(
    "journals stale %s without a delivery event",
    async (stage) => {
      deps.reverify = vi
        .fn()
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce(stage === "before PR" ? "stale" : "ok")
        .mockResolvedValue("stale");
      expect(await run()).toEqual({ status: "stale" });
      expect(await host.remoteBranchSha("app", branch)).not.toBeNull();
      expect(publish).not.toHaveBeenCalled();
      expect((await journal.read(key)).at(-1)?.step).toBe("stale");
      expect(await host.findPr("app", branch)).toEqual(
        stage === "before PR" ? null : expect.any(Object),
      );
    },
  );

  it("drops delivery when fencing changes between reverify and the publisher intent", async () => {
    const original = required(publish.getMockImplementation());
    publish.mockImplementation(async (intent, opts) => {
      const state = replay(log.entries);
      required(required(state.tasks[T1]).items.W1).lease = null;
      expect(intent(state)).toBeNull();
      return { status: "dropped", eventId: required(opts?.eventId) };
    });
    expect(await run()).toEqual({ status: "stale" });
    expect(publish).toHaveBeenCalledOnce();
    publish.mockImplementation(original);
  });

  it("reuses an existing PR and retargets its base after a fresh reverify", async () => {
    const found = vi.spyOn(host, "findPr").mockResolvedValue({
      number: 7,
      url: "https://example.invalid/pr/7",
      head: branch,
      base: "old-base",
      title: "Example",
      state: "open",
      mergeSha: null,
    });
    const retarget = vi.spyOn(host, "retargetPr").mockResolvedValue();
    const create = vi.spyOn(host, "createPr");
    expect(await run()).toMatchObject({ status: "delivered" });
    expect(retarget).toHaveBeenCalledWith("app", 7, "main");
    expect(create).not.toHaveBeenCalled();
    expect(found).toHaveBeenCalledOnce();
  });

  it("persists an event id and retries an ambiguous accepted push with that same id", async () => {
    const original = required(publish.getMockImplementation());
    publish.mockImplementationOnce(async (intent, opts) => {
      const accepted = await original(intent, opts);
      return { ...accepted, status: "failed", reason: "Lost acknowledgement" };
    });
    expect(await run()).toMatchObject({ status: "pending" });
    deps.reverify = vi.fn(async () => "stale" as const);
    expect(await run()).toMatchObject({ status: "delivered" });
    expect(publish.mock.calls[0]?.[1]?.eventId).toBe(publish.mock.calls[1]?.[1]?.eventId);
    expect(log.events.filter((event) => event?.type === "work.delivered")).toHaveLength(1);
    expect(adapter.invocations).toHaveLength(1);
    expect(checkCounter).toBe(1);
  });

  it.each(["committed", "checks", "pushed", "pr", "publish_pending"])(
    "recovers a crash after %s without rerunning the agent or duplicating a PR",
    async (crashStep) => {
      const append = journal.append.bind(journal);
      let crashed = false;
      deps.journal = {
        ...journal,
        path: journal.path.bind(journal),
        read: journal.read.bind(journal),
        append: async (attempt, record) => {
          const saved = await append(attempt, record);
          if (
            record.step === crashStep &&
            !crashed &&
            (record.step !== "checks" || record.phase === "work")
          ) {
            crashed = true;
            throw new Error("simulated crash");
          }
          return saved;
        },
      };
      await expect(run()).rejects.toThrow("simulated crash");
      deps.journal = journal;
      expect(await run()).toMatchObject({ status: "delivered" });
      expect(adapter.invocations).toHaveLength(1);
      expect(checkCounter).toBe(1);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it("does not rerun an invocation that crashed before its completion was journaled", async () => {
    const append = journal.append.bind(journal);
    deps.journal = {
      path: journal.path.bind(journal),
      read: journal.read.bind(journal),
      append: async (attempt, record) => {
        if (record.step === "invocation_done") throw new Error("simulated crash");
        return append(attempt, record);
      },
    };
    await expect(run()).rejects.toThrow("simulated crash");
    deps.journal = journal;
    expect(await run()).toMatchObject({ status: "failed", class: "crash" });
    expect(adapter.invocations).toHaveLength(1);
  });

  it("does not rerun a factory invocation whose pre-launch intent was journaled before a crash", async () => {
    const append = journal.append.bind(journal);
    deps.journal = {
      path: journal.path.bind(journal),
      read: journal.read.bind(journal),
      append: async (attempt, record) => {
        const saved = await append(attempt, record);
        if (record.step === "invocation_started") throw new Error("simulated crash");
        return saved;
      },
    };
    deps.adapter = () => adapter;
    await expect(run()).rejects.toThrow("simulated crash");
    deps.journal = journal;
    expect(await run()).toMatchObject({ status: "failed", class: "crash" });
    expect(adapter.invocations).toHaveLength(0);
  });

  it.each(["none", "ask"] as const)(
    "checkpoints interrupted %s work locally without code-host access",
    async (method) => {
      input.submit = { method, host: "github" };
      deps.adapter = {
        cli: "codex",
        probe: adapter.probe.bind(adapter),
        invoke: async (inv) => {
          await writeFile(join(inv.cwd, "result.txt"), "partial\n");
          return {
            outcome: "interrupted",
            exitCode: 130,
            finalMessage: null,
            usage: null,
            durationMs: 1,
            pid: null,
          };
        },
      };
      for (const port of [
        "remoteBranchSha",
        "findPr",
        "createPr",
        "prState",
        "retargetPr",
        "closePr",
      ] as const)
        vi.spyOn(host, port).mockRejectedValue(
          new Error("Local checkpoint must not use the code host"),
        );
      const gitRun = vi.spyOn(git, "run");
      expect(await run()).toMatchObject({
        status: "checkpointed",
        snapshot: { pushed: false, head_sha: expect.any(String) },
      });
      expect(gitRun.mock.calls.some(([argv]) => argv.includes("push"))).toBe(false);
      expect(log.events.at(-1)?.type).toBe("checkpoint.recorded");
    },
  );

  it("checkpoints interrupted edits with a signed WIP commit pushed before the event", async () => {
    deps.adapter = {
      cli: "codex",
      probe: adapter.probe.bind(adapter),
      invoke: async (inv) => {
        await writeFile(join(inv.cwd, "result.txt"), "partial\n");
        return {
          outcome: "interrupted",
          exitCode: 130,
          finalMessage: null,
          usage: null,
          durationMs: 1,
          pid: null,
        };
      },
    };
    const result = await run();
    expect(result).toMatchObject({
      status: "checkpointed",
      snapshot: {
        invocation_state: "interrupted",
        pushed: true,
        diffstat: { files: 1, insertions: 1, deletions: 1 },
        files_changed: ["result.txt"],
        agent_note: null,
      },
    });
    const event = required(log.events.at(-1));
    expect(event.type).toBe("checkpoint.recorded");
    const head = await host.remoteBranchSha("app", branch);
    expect((await git.run(["cat-file", "-p", required(head)], { cwd: remote })).stdout).toContain(
      "skep-wip:",
    );
    expect(await host.findPr("app", branch)).toBeNull();
  });

  it("bounds a SIGKILL wait that never resolves and checkpoints unknown without unstable code", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    deps.clock = clock;
    deps.shutdownMs = 25;
    input.timeoutMs = 10;
    const signalGroup = vi.fn();
    deps.runtime = {
      name: "native",
      isAlive: async () => true,
      spawn: async () => ({
        pid: 42,
        pgid: 42,
        startToken: "start",
        wait: () => new Promise<ProcessExit>(() => {}),
        signalGroup,
      }),
    };
    deps.adapter = (runtime, interrupt) => ({
      cli: "codex",
      probe: adapter.probe.bind(adapter),
      invoke: async (inv) => {
        const h = await runtime.spawn({
          argv: ["example-cli"],
          cwd: inv.cwd,
          env: inv.env,
          logPath: inv.logPath,
        });
        await interrupt(h, clock, { graceMs: 1, termMs: 1 });
        throw new Error("Unreachable");
      },
    });
    const pending = run();
    await expect
      .poll(async () => (await journal.read(key)).some((record) => record.start_token === "start"))
      .toBe(true);
    await vt.advance(40);
    const result = await pending;
    expect(result).toMatchObject({
      status: "checkpointed",
      snapshot: { invocation_state: "unknown", head_sha: null, pushed: false },
    });
    expect(signalGroup).toHaveBeenCalledWith("SIGKILL");
    expect(await host.remoteBranchSha("app", branch)).toBeNull();
    expect(vt.nextTimerAt()).toBeNull();
    const records = await journal.read(key);
    expect(records.filter((record) => record.step === "invoked")).toHaveLength(1);
    expect(records.find((record) => record.step === "invoked")).toMatchObject({
      pid: 42,
      pgid: 42,
      start_token: "start",
    });
    expect(records.filter((record) => record.step === "invocation_started")).toHaveLength(1);
  });

  it("classifies a bounded invocation timeout as work.failed rather than a voluntary checkpoint", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    deps.clock = clock;
    input.timeoutMs = 10;
    deps.adapter = adapter = new FakeAdapter({
      clock,
      seed: 1,
      scripts: { work: { kind: "hang" } },
    });
    const pending = run();
    await expect.poll(() => adapter.invocations.length).toBe(1);
    await vt.advance(10);
    expect(await pending).toMatchObject({ status: "failed", class: "timeout" });
    expect(log.events.at(-1)?.type).toBe("work.failed");
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("durably interrupts for a barrier and checkpoints before parking the lease", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    deps.clock = clock;
    deps.adapter = adapter = new FakeAdapter({
      clock,
      seed: 1,
      scripts: { work: { kind: "hang" } },
    });
    const runner = new AttemptRunner(deps);
    const pending = runner.run(input);
    await expect.poll(() => adapter.invocations.length).toBe(1);
    const state = replay(log.entries);
    log.append({
      type: "replan.requested",
      task_id: T1,
      actor: "human",
      pre: { task_rev: required(state.tasks[T1]).rev },
      payload: { summary: "Revise the example plan", evidence: [], item: "W1" },
    });
    const barrier = required(required(replay(log.entries).tasks[T1]).barrier);
    expect(await runner.interrupt(key, barrier.id)).toBe(true);
    expect(await pending).toMatchObject({
      status: "checkpointed",
      snapshot: { invocation_state: "interrupted", pushed: true },
    });
    expect(log.events.at(-1)?.payload).toMatchObject({ barrier_id: barrier.id });
    expect(replay(log.entries).tasks[T1]?.items.W1?.status).toBe("interrupted");
    expect(
      (await journal.read(key)).find((entry) => entry.step === "interrupt_requested"),
    ).toMatchObject({ barrier_id: barrier.id });
    expect(await runner.interrupt(key)).toBe(false);
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("recovers an interrupted barrier without losing its id or rerunning the agent", async () => {
    const append = journal.append.bind(journal);
    deps.journal = {
      path: journal.path.bind(journal),
      read: journal.read.bind(journal),
      append: async (attempt, record) => {
        if (record.step === "invocation_done") throw new Error("simulated crash");
        return append(attempt, record);
      },
    };
    deps.adapter = {
      cli: "codex",
      probe: adapter.probe.bind(adapter),
      invoke: async () => ({
        outcome: "interrupted",
        exitCode: 130,
        finalMessage: null,
        usage: null,
        durationMs: 1,
        pid: null,
      }),
    };
    await expect(run()).rejects.toThrow("simulated crash");
    const state = replay(log.entries);
    log.append({
      type: "replan.requested",
      task_id: T1,
      actor: "human",
      pre: { task_rev: required(state.tasks[T1]).rev },
      payload: { summary: "Revise the example plan", evidence: [], item: "W1" },
    });
    const barrier = required(required(replay(log.entries).tasks[T1]).barrier);
    await journal.append(key, { step: "interrupt_requested", barrier_id: barrier.id });
    deps.journal = journal;
    expect(await run()).toMatchObject({
      status: "checkpointed",
      snapshot: { invocation_state: "unknown", head_sha: null, pushed: false },
    });
    expect(log.events.at(-1)?.payload).toMatchObject({ barrier_id: barrier.id });
    expect(adapter.invocations).toHaveLength(0);
  });

  it.each(["pattern", "gitleaks", "model"])(
    "settles a barrier with work.failed when checkpointing hits a $0 secret",
    async (source) => {
      if (source === "gitleaks") scanner.mockResolvedValue({ status: "secrets_detected" });
      deps.adapter = {
        cli: "codex",
        probe: adapter.probe.bind(adapter),
        invoke: async (inv) => {
          const state = replay(log.entries);
          log.append({
            type: "replan.requested",
            task_id: T1,
            actor: "human",
            pre: { task_rev: required(state.tasks[T1]).rev },
            payload: { summary: "Revise the example plan", evidence: [], item: "W1" },
          });
          const barrier = required(required(replay(log.entries).tasks[T1]).barrier);
          expect(await runner.interrupt(key, barrier.id)).toBe(true);
          await writeFile(
            join(inv.cwd, "result.txt"),
            source === "pattern" ? `partial\n${secret}\n` : "partial\n",
          );
          return {
            outcome: "interrupted",
            exitCode: 130,
            finalMessage:
              source === "model" ? JSON.stringify({ ...report, summary: secret }) : null,
            usage: null,
            durationMs: 1,
            pid: null,
          };
        },
      };
      const runner = new AttemptRunner(deps);
      expect(await runner.run(input)).toMatchObject({
        status: "failed",
        class: "secret_detected",
        publication: { status: "accepted" },
      });
      expect(publish).toHaveBeenCalledOnce();
      expect(log.events.at(-1)).toMatchObject({
        type: "work.failed",
        payload: { class: "secret_detected", detail: secretFailureDetail },
      });
      const task = required(replay(log.entries).tasks[T1]);
      expect(task.items.W1?.lease).toBeNull();
      expect(task.status).toBe("replanning");
      expect(task.barrier?.closed_seq).not.toBeNull();
      expect(log.events.some((event) => event?.type === "checkpoint.recorded")).toBe(false);
      expect(scanner).toHaveBeenCalledTimes(source === "model" ? 0 : 1);
      expect(await host.remoteBranchSha("app", branch)).toBeNull();
      expect(await host.findPr("app", branch)).toBeNull();
      expect(await readFile(journal.path(key), "utf8")).not.toContain(secret);
    },
  );

  it("never forwards agent or provider environment variables to daemon Git writes", async () => {
    deps.gitEnv = {
      OPENAI_API_KEY: "blocked",
      CODEX_HOME: "blocked",
      GH_TOKEN: "blocked",
    };
    const calls = vi.spyOn(git, "run");
    expect(await run()).toMatchObject({ status: "delivered" });
    const writes = calls.mock.calls.filter(
      ([args]) =>
        args.includes("hash-object") || args.includes("update-ref") || args.includes("add"),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const [, options] of writes) {
      expect(options.env ?? {}).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env ?? {}).not.toHaveProperty("CODEX_HOME");
      expect(options.env ?? {}).not.toHaveProperty("GH_TOKEN");
    }
    calls.mockRestore();
  });

  it("rejects invalid external input, wrong assignees and changed recovery identity", async () => {
    await expect(
      new AttemptRunner(deps).run({ ...input, extra: true } as AttemptInput),
    ).rejects.toThrow(AttemptError);
    await expect(
      new AttemptRunner(deps).run({ ...input, lease: { ...input.lease, holder: "mac.coding" } }),
    ).rejects.toThrow("assignee");
    await run();
    await expect(
      new AttemptRunner(deps).run({ ...input, attemptId: "att_112233445566" }),
    ).rejects.toThrow("Recovery input");
    expect(await readFile(join(worktree(), "result.txt"), "utf8")).toBe("good\n");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}
