import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, initRepo, tempDir } from "../../test/helpers/git-fixture.js";
import {
  agentRegistered,
  LogBuilder,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { FakeAdapter } from "../adapter/fake.js";
import type { PublishResult } from "../blackboard/publisher.js";
import { FakeCodeHost } from "../codehost/fake.js";
import { workBranch } from "../core/ids.js";
import { draft, revokeIntent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import { NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { isCurrentLease } from "../lease/reverify.js";
import { systemClock } from "../util/clock.js";
import {
  type AttemptInput,
  AttemptPublicationSchema,
  AttemptRunner,
  type AttemptRunnerDependencies,
} from "./attempt.js";
import { type AttemptKey, Journal, verificationKey } from "./journal.js";
import {
  AttemptReconciler,
  nativeReconcileProcesses,
  type ReconcileDependencies,
  ReconcileError,
} from "./reconcile.js";
import { Redactor } from "./redact.js";
import { CodeMirror } from "./worktree.js";

const key: AttemptKey = { task: T1, item: "W1", epoch: 1 };
const branch = workBranch(T1, "W1", 1);
class Crash extends Error {}

describe("restart reconciliation", () => {
  let root: string;
  let input: AttemptInput;
  let journal: Journal;
  let deps: ReconcileDependencies;
  let log: LogBuilder;
  let host: FakeCodeHost;
  let adapter: FakeAdapter;
  const git = new NodeGitRunner();

  beforeEach(async () => {
    root = await tempDir("reconcile-");
    const remote = join(root, "remote.git");
    const writer = join(root, "writer");
    await initRepo(remote, { bare: true });
    await initRepo(writer);
    const base = await commitFile(git, writer, "example.txt", "base\n");
    await git.run(["push", remote, `${base}:refs/heads/main`], { cwd: writer });
    const plan = samplePlan({ base: { repo: "app", branch: "main", commit: base } });
    const item = plan.items[0];
    if (!item) throw new Error("Missing example plan item");
    item.acceptance = [{ kind: "manual", text: "Inspect the example change." }];
    input = {
      lease: { task_id: T1, item: "W1", epoch: 1, holder: VPS },
      attemptId: "att_restart",
      plan,
      baseSha: base,
      prBase: "main",
      submit: { method: "pr", host: "github" },
      agentInstructions: "Implement the example change.",
      repoContext: "Example repository.",
      timeoutMs: 10_000,
    };
    journal = new Journal({
      roleDir: join(root, "role"),
      clock: systemClock,
      redactor: new Redactor(),
    });
    host = new FakeCodeHost({ git, repo: "app", repoDir: remote });
    adapter = new FakeAdapter({
      clock: systemClock,
      seed: 42,
      scripts: { work: { kind: "success", files: [{ path: "example.txt", content: "good\n" }] } },
    });
    vi.spyOn(adapter, "invoke");
    log = new LogBuilder();
    log.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    log.append({
      type: "task.created",
      task_id: T1,
      actor: "human",
      payload: taskCreated({ repo: "app" }),
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
    const keyPath = join(root, "vps");
    await writeFile(
      keyPath,
      await readFile(fileURLToPath(new URL("../../test/fixtures/keys/vps", import.meta.url))),
      { mode: 0o600 },
    );
    deps = {
      git,
      journal,
      codeHost: host,
      adapter,
      clock: systemClock,
      mirror: new CodeMirror({
        git,
        home: join(root, "home"),
        worktreeRoot: join(root, "worktrees"),
        repos: [{ name: "app", url: remote }],
      }),
      signer: new SshKeySigner({ principal: "daemon:vps", keyPath }),
      ident: { name: "Skep Daemon", email: "skepd@example.invalid", tz: "+0000" },
      agentEnv: { home: root, user: "agent", source: {} },
      redactor: new Redactor(),
      scratchDir: join(root, "scratch"),
      checks: {
        load: vi.fn(async () => ({ schema: "skep.checks/v1" as const, checks: {} })),
        run: vi.fn(async () => []),
      },
      scanSecrets: vi.fn(async () => ({ status: "clean" as const })),
      observeNow: vi.fn(async () => replay(log.entries)),
      reverify: vi.fn(async (lease) =>
        isCurrentLease(replay(log.entries), lease) ? "ok" : "stale",
      ),
      processes: {
        startToken: vi.fn(async () => null),
        bootId: vi.fn(async () => "os-boot-current"),
        killGroup: vi.fn(async () => {}),
      },
      publisher: {
        publish: vi.fn(async (intent, options): Promise<PublishResult> => {
          const state = replay(log.entries);
          const eventId = options?.eventId;
          if (!eventId) throw new Error("Recovery must publish with its saved id");
          const seen = state.seen_event_ids[eventId];
          if (seen !== undefined) return { status: "accepted", eventId, seq: seen };
          const event = intent(state);
          if (!event) return { status: "dropped", eventId };
          log.append({
            type: event.type,
            task_id: event.task_id,
            actor: event.actor,
            payload: event.payload,
            pre: event.pre,
            event_id: eventId,
          });
          const outcome = replay(log.entries).outcomes.at(-1);
          expect(outcome?.outcome).toBe("accepted");
          return { status: "accepted", eventId, seq: outcome?.seq };
        }),
      },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function stopAt(step: string) {
    const saved: AttemptRunnerDependencies["journal"] = {
      path: journal.path.bind(journal),
      read: journal.read.bind(journal),
      async append(attempt, record) {
        const result = await journal.append(attempt, record);
        if (record.step === step) throw new Crash(step);
        return result;
      },
    };
    await expect(new AttemptRunner({ ...deps, journal: saved }).run(input)).rejects.toThrow(Crash);
  }
  it.each(
    ["push", "none", "ask"].flatMap((method) =>
      ["submit", "publish_pending"].map((step) => ({
        method: method as "push" | "none" | "ask",
        step,
      })),
    ),
  )("recovers $method at $step without PR checks or code-host access", async ({ method, step }) => {
    input.submit = { method, host: "github" };
    await stopAt(step);
    await journal.append(key, {
      step: "pr",
      pr: {
        number: 99,
        url: "https://example.invalid/pull/99",
        head: branch,
        base: "main",
        title: "Unrelated stale record",
        state: "open",
        mergeSha: null,
      },
    });
    for (const port of [
      "remoteBranchSha",
      "findPr",
      "createPr",
      "prState",
      "retargetPr",
      "closePr",
    ] as const)
      vi.spyOn(host, port).mockRejectedValue(new Error("No code host for this method"));
    const gitRun = vi.spyOn(git, "run");
    expect(await new AttemptReconciler(deps).reconcile()).toMatchObject([
      { result: { status: "delivered" } },
    ]);
    expect(adapter.invoke).toHaveBeenCalledOnce();
    expect(gitRun.mock.calls.filter(([argv]) => argv.includes("push"))).toHaveLength(
      method === "push" && step === "submit" ? 1 : 0,
    );
  });

  const recover = () => new AttemptReconciler(deps).reconcile();
  async function processRecord(token: string, bootId?: string) {
    await journal.append(key, {
      step: "invoked",
      kind: "work",
      pid: 123,
      pgid: 123,
      start_token: token,
      ...(bootId ? { boot_id: bootId } : {}),
    });
  }

  it("observes the blackboard before enumerating unfinished attempts", async () => {
    const enumerate = vi.spyOn(journal, "unfinishedAttempts");
    expect(await recover()).toEqual([]);
    expect(deps.observeNow).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.observeNow).mock.invocationCallOrder[0]).toBeLessThan(
      enumerate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { saved: "start-123", actual: "start-123", kills: 1 },
    { saved: "start-123", actual: null, kills: 1 },
    { saved: "", actual: null, kills: 0 },
    { saved: "", actual: "new-start", kills: 0 },
    { saved: "", actual: null, boot: "os-boot-current", kills: 1 },
    { saved: "", actual: "new-start", boot: "os-boot-current", kills: 0 },
    { saved: "", actual: null, boot: "os-boot-previous", kills: 0 },
    { saved: "", actual: "new-start", boot: "os-boot-previous", kills: 0 },
    { saved: "start-123", actual: "new-start", kills: 0 },
  ])(
    "fences and terminates the recorded group ($saved/$actual/$boot)",
    async ({ saved, actual, boot, kills }) => {
      await stopAt("preflight_ok");
      await processRecord(saved, boot);
      if (!deps.processes) throw new Error("Missing process port");
      vi.mocked(deps.processes.startToken).mockResolvedValue(actual);
      expect(await recover()).toMatchObject([
        { key, result: { status: "failed", class: "crash" } },
      ]);
      expect(deps.processes.killGroup).toHaveBeenCalledTimes(kills);
      if (!kills) {
        expect(await journal.read(key)).toContainEqual(
          expect.objectContaining({
            step:
              saved === "" && boot !== "os-boot-current" ? "process_unverified" : "process_reused",
            pgid: 123,
          }),
        );
      }
      if (kills) {
        expect(deps.processes.killGroup).toHaveBeenCalledWith(123);
        expect(vi.mocked(deps.processes.killGroup).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(deps.publisher.publish).mock.invocationCallOrder[0] ?? 0,
        );
      }
      expect(adapter.invoke).not.toHaveBeenCalled();
      expect(await recover()).toEqual([]);
    },
  );

  it("leaves an attempt unfinished when group termination fails", async () => {
    await stopAt("preflight_ok");
    await processRecord("", "os-boot-current");
    if (!deps.processes) throw new Error("Missing process port");
    vi.mocked(deps.processes.killGroup).mockRejectedValue(new ReconcileError("Cannot stop group"));
    await expect(recover()).rejects.toThrow("Cannot stop group");
    expect(deps.publisher.publish).not.toHaveBeenCalled();
    expect(await journal.unfinishedAttempts()).toEqual([key]);
  });

  it("does not inspect or kill an empty-token group without journaled boot evidence", async () => {
    await stopAt("preflight_ok");
    await processRecord("");
    if (!deps.processes) throw new Error("Missing process port");
    vi.mocked(deps.processes.startToken).mockRejectedValue(
      new Error("Example metadata is unreadable"),
    );
    expect(await recover()).toMatchObject([{ result: { status: "failed", class: "crash" } }]);
    expect(deps.processes.startToken).not.toHaveBeenCalled();
    expect(deps.processes.killGroup).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    "skips empty-token groups when current boot identity is %s",
    async (boot) => {
      await stopAt("preflight_ok");
      await processRecord("", "os-boot-current");
      if (!deps.processes) throw new Error("Missing process port");
      if (boot === undefined) delete deps.processes.bootId;
      else deps.processes.bootId = vi.fn(async () => boot);
      expect(await recover()).toMatchObject([{ result: { status: "failed", class: "crash" } }]);
      expect(deps.processes.killGroup).not.toHaveBeenCalled();
      expect(deps.processes.startToken).not.toHaveBeenCalled();
    },
  );

  it("requires readable group leader metadata even when the boot matches", async () => {
    await stopAt("preflight_ok");
    await processRecord("", "os-boot-current");
    if (!deps.processes) throw new Error("Missing process port");
    vi.mocked(deps.processes.startToken).mockRejectedValue(
      new ReconcileError("Cannot read leader"),
    );
    await expect(recover()).rejects.toThrow("Cannot read leader");
    expect(deps.processes.killGroup).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
    expect(await journal.unfinishedAttempts()).toEqual([key]);
  });

  it("stops orphan checks and never repeats checks with an unknown outcome", async () => {
    await stopAt("checks_started");
    await journal.append(key, {
      step: "check_started",
      pid: 456,
      pgid: 456,
      start_token: "check-456",
    });
    expect(await recover()).toMatchObject([{ result: { status: "failed", class: "crash" } }]);
    expect(deps.processes?.killGroup).toHaveBeenCalledWith(456);
    expect(deps.checks.run).not.toHaveBeenCalled();
    expect(adapter.invoke).toHaveBeenCalledOnce();
  });

  it("stops an interrupted verification without reopening the delivered attempt", async () => {
    expect(await new AttemptRunner(deps).run(input)).toMatchObject({ status: "delivered" });
    const finished = await journal.read(key);
    const verification = verificationKey(T1, "activation-1");
    await journal.append(verification, {
      step: "check_started",
      pid: 456,
      pgid: 456,
      start_token: "check-456",
    });
    expect(await recover()).toMatchObject([{ key: verification, result: { status: "stale" } }]);
    expect(deps.processes?.killGroup).toHaveBeenCalledWith(456);
    expect(await journal.read(key)).toEqual(finished);
    expect(replay(log.entries).tasks[T1]?.status).toBe("delivered");
    expect(await recover()).toEqual([]);
  });

  it("settles a newly opened barrier with an unknown checkpoint", async () => {
    await stopAt("invoked");
    const event = draft(
      "replan.requested",
      T1,
      "human",
      { item: "W1", summary: "Checkpoint the example attempt.", evidence: [] },
      { task_rev: replay(log.entries).tasks[T1]?.rev },
    );
    log.append(event);
    expect(await recover()).toMatchObject([
      {
        result: {
          status: "checkpointed",
          snapshot: { invocation_state: "unknown", head_sha: null, pushed: false },
        },
      },
    ]);
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(replay(log.entries).tasks[T1]?.status).toBe("replanning");
  });

  it("kills recorded groups before marking a revoked attempt stale", async () => {
    await stopAt("preflight_ok");
    await processRecord("", "os-boot-current");
    const event = revokeIntent({
      task_id: T1,
      item: "W1",
      epoch: 1,
      reason: "End the example lease.",
    })(replay(log.entries));
    if (!event) throw new Error("Missing revocation intent");
    log.append(event);
    expect(await recover()).toMatchObject([{ result: { status: "stale" } }]);
    expect(deps.processes?.killGroup).toHaveBeenCalledWith(123);
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it("re-publishes a pending delivery using the journaled event id", async () => {
    await stopAt("publish_pending");
    const publication = (await journal.read(key)).findLast(
      (record) => record.step === "publish_pending",
    )?.publication;
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    expect(deps.publisher.publish).toHaveBeenLastCalledWith(expect.any(Function), {
      eventId: AttemptPublicationSchema.parse(publication).event_id,
    });
    expect(adapter.invoke).toHaveBeenCalledOnce();
    expect(host.list()).toHaveLength(1);
  });

  it("replaces a pending delivery with a durable unknown checkpoint under a barrier", async () => {
    await stopAt("publish_pending");
    const saved = AttemptPublicationSchema.parse(
      (await journal.read(key)).findLast((record) => record.step === "publish_pending")
        ?.publication,
    );
    log.append(
      draft(
        "replan.requested",
        T1,
        "human",
        { item: "W1", summary: "Checkpoint the example delivery.", evidence: [] },
        { task_rev: replay(log.entries).tasks[T1]?.rev },
      ),
    );
    vi.mocked(deps.publisher.publish).mockResolvedValueOnce({
      status: "failed",
      reason: "Example outage",
      eventId: saved.event_id,
    });
    expect(await recover()).toMatchObject([{ result: { status: "pending" } }]);
    const publications = (await journal.read(key))
      .filter((record) => record.step === "publish_pending")
      .map((record) => AttemptPublicationSchema.parse(record.publication));
    expect(publications).toHaveLength(2);
    expect(publications[0]).toEqual(saved);
    const checkpoint = publications[1];
    expect(checkpoint?.type).toBe("checkpoint.recorded");
    expect(checkpoint?.event_id).not.toBe(saved.event_id);
    expect(await recover()).toMatchObject([
      {
        result: { status: "checkpointed", snapshot: { invocation_state: "unknown" } },
      },
    ]);
    for (const [, options] of vi.mocked(deps.publisher.publish).mock.calls)
      expect(options?.eventId).toBe(checkpoint?.event_id);
    expect(replay(log.entries).tasks[T1]?.status).toBe("replanning");
    expect(replay(log.entries).tasks[T1]?.barrier?.checkpointed).toEqual(["W1"]);
    expect(adapter.invoke).toHaveBeenCalledOnce();
    expect(await recover()).toEqual([]);
  });

  it("acknowledges an already accepted event after its lease has ended", async () => {
    const publish = deps.publisher.publish;
    deps.publisher.publish = vi.fn(async (intent, options) => {
      await publish(intent, options);
      throw new Crash("lost acknowledgement");
    });
    await expect(new AttemptRunner(deps).run(input)).rejects.toThrow(Crash);
    const state = replay(log.entries);
    expect(state.tasks[T1]?.status).toBe("delivered");
    deps.publisher.publish = publish;
    if (!deps.scanSecrets) throw new Error("Missing secret scanner");
    const scan = vi.mocked(deps.scanSecrets);
    const scanCalls = scan.mock.calls.length;
    const prState = vi.spyOn(host, "prState");
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    expect(scan).toHaveBeenCalledTimes(scanCalls);
    expect(prState).not.toHaveBeenCalled();
    expect(
      replay(log.entries).outcomes.filter((outcome) => outcome.type === "work.delivered"),
    ).toHaveLength(1);
    expect(await recover()).toEqual([]);
  });

  it("keeps the saved event id through publication outages and later recovery", async () => {
    await stopAt("publish_pending");
    const records = await journal.read(key);
    const saved = AttemptPublicationSchema.parse(
      records.findLast((record) => record.step === "publish_pending")?.publication,
    );
    vi.mocked(deps.publisher.publish).mockResolvedValueOnce({
      status: "failed",
      eventId: saved.event_id,
      reason: "Example remote is unavailable",
    });
    expect(await recover()).toMatchObject([{ result: { status: "pending" } }]);
    expect(await journal.unfinishedAttempts()).toEqual([key]);
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    for (const [, options] of vi.mocked(deps.publisher.publish).mock.calls) {
      expect(options?.eventId).toBe(saved.event_id);
    }
    expect(host.list()).toHaveLength(1);
    expect(adapter.invoke).toHaveBeenCalledOnce();
  });

  it("reverifies a saved open PR and never recreates it", async () => {
    await stopAt("pr");
    const prState = vi.spyOn(host, "prState");
    const find = vi.spyOn(host, "findPr");
    const create = vi.spyOn(host, "createPr");
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    expect(prState).toHaveBeenCalledWith("app", 1);
    expect(deps.reverify).toHaveBeenCalledWith(input.lease);
    expect(find).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { state: "closed", step: "pr" },
    { state: "merged", step: "pr" },
    { state: "closed", step: "publish_pending" },
    { state: "merged", step: "publish_pending" },
  ])("ends the lease when a PR is $state before delivery ($step)", async ({ state, step }) => {
    await stopAt(step);
    if (state === "closed") await host.closePr("app", 1, "End the example PR.");
    else await host.merge(1);
    const prState = vi.spyOn(host, "prState");
    const find = vi.spyOn(host, "findPr");
    const create = vi.spyOn(host, "createPr");
    expect(await recover()).toMatchObject([{ result: { status: "failed", class: "crash" } }]);
    expect(prState).toHaveBeenCalledWith("app", 1);
    expect(find).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(deps.publisher.publish).toHaveBeenCalledOnce();
    expect(replay(log.entries).tasks[T1]?.items.W1?.lease).toBeNull();
    expect(log.events.at(-1)).toMatchObject({
      type: "work.failed",
      payload: { class: "crash", detail: expect.stringContaining(state) },
    });
    expect(host.list()).toHaveLength(1);
    expect(adapter.invoke).toHaveBeenCalledOnce();
    expect(await recover()).toEqual([]);
  });

  it("uses the publication's PR number if the PR record is missing", async () => {
    await stopAt("publish_pending");
    const records = (await journal.read(key)).filter((record) => record.step !== "pr");
    await writeFile(
      journal.path(key),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const prState = vi.spyOn(host, "prState");
    const find = vi.spyOn(host, "findPr");
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    expect(prState).toHaveBeenCalledWith("app", 1);
    expect(find).not.toHaveBeenCalled();
  });

  it("fails closed on a torn first record without launching the agent", async () => {
    await journal.append(key, { step: "claimed", input });
    await writeFile(journal.path(key), '{"step":"claimed"');
    expect(await recover()).toMatchObject([{ result: { status: "failed", class: "crash" } }]);
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("repairs a torn publication tail and keeps the previous durable event id", async () => {
    await stopAt("publish_pending");
    await appendFile(journal.path(key), '{"step":"delivered_published"');
    expect(await recover()).toMatchObject([{ result: { status: "delivered" } }]);
    expect(await journal.unfinishedAttempts()).toEqual([]);
  });

  it("rejects malformed process ids before signalling", async () => {
    await stopAt("preflight_ok");
    await journal.append(key, { step: "invoked", pid: 0, pgid: -1, start_token: "" });
    await expect(recover()).rejects.toThrow(ReconcileError);
    expect(deps.processes?.killGroup).not.toHaveBeenCalled();
  });

  it("rejects input for another epoch rather than publishing against it", async () => {
    await journal.append(key, {
      step: "claimed",
      input: { ...input, lease: { ...input.lease, epoch: 2 } },
    });
    await expect(recover()).rejects.toThrow("does not match");
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it("native termination signals the negative pgid and ignores only ESRCH", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Gone"), { code: "ESRCH" });
    });
    await nativeReconcileProcesses.killGroup(123);
    expect(kill).toHaveBeenCalledWith(-123, "SIGKILL");
    kill.mockImplementation(() => {
      throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
    });
    await expect(nativeReconcileProcesses.killGroup(123)).rejects.toThrow(ReconcileError);
  });
});
