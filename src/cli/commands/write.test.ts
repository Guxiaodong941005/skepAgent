import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, initRepo, writeAllowedSigners } from "../../../test/helpers/git-fixture.js";
import { genesisDoc } from "../../../test/helpers/log-builder.js";
import { BlackboardClone } from "../../blackboard/clone.js";
import { createGenesis } from "../../blackboard/genesis.js";
import { fullReplaySource, Publisher } from "../../blackboard/publisher.js";
import { skepPaths } from "../../config/paths.js";
import { contentHash } from "../../core/canonical.js";
import { type IntentSpec, intentFromSpec } from "../../core/intent-spec.js";
import { draft } from "../../core/intents.js";
import type { Plan } from "../../core/schemas/plan.js";
import { IpcServer } from "../../daemon/ipc-server.js";
import { Redactor } from "../../exec/redact.js";
import { NodeGitRunner } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import { systemClock } from "../../util/clock.js";
import { cryptoRandom } from "../../util/random.js";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";

const TASK = "T-20261005-7f3a";

interface Captured {
  stdout: string;
  stderr: string;
  ctx: CliContext;
}

/** In-memory streams plus a temp SKEP_HOME. Nothing here touches a real home directory. */
function capture(home: string): Captured {
  const out = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    stdout: {
      write: (s) => {
        out.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        out.stderr += s;
      },
    },
    env: { SKEP_HOME: home },
    output: () => {
      throw new Error("output() used before runCli");
    },
  };
  return {
    get stdout() {
      return out.stdout;
    },
    get stderr() {
      return out.stderr;
    },
    ctx,
  };
}

function jsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

describe("write commands through the daemon", () => {
  const dirs: string[] = [];
  let server: IpcServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A daemon that records the publish it was asked for and answers with a fixed verdict. */
  async function daemon(
    answer: unknown,
  ): Promise<{ home: string; seen: { method: string; params: unknown }[] }> {
    const home = await mkdtemp(join(tmpdir(), "skep-cli-write-"));
    dirs.push(home);
    const seen: { method: string; params: unknown }[] = [];
    server = new IpcServer({
      socketPath: skepPaths(home).socket,
      redactor: new Redactor(),
      handlers: {
        status: async () => ({}),
        log: async () => ({}),
        publish: async (params) => {
          seen.push({ method: "publish", params });
          return answer;
        },
        agentStart: async (params) => {
          seen.push({ method: "agent.start", params });
          return { started: true };
        },
        agentStop: async (params) => {
          seen.push({ method: "agent.stop", params });
          return { stopped: true };
        },
        logsTail: async () => ({}),
        doctor: async () => ({}),
        ping: async () => ({ pong: true }),
      },
    });
    await server.start();
    return { home, seen };
  }

  it("prints accepted with #seq for task new", async () => {
    const { home, seen } = await daemon({ status: "accepted", seq: 4, eventId: "evt_x" });
    const cap = capture(home);
    const code = await runCli(
      ["task", "new", "Add a dark mode toggle", "--repo", "app", "--owner", "vps.coding"],
      cap.ctx,
    );
    expect(code).toBe(0);
    expect(cap.stdout).toBe("accepted #4\n");
    expect(cap.stderr).toBe("");
    const params = seen[0]?.params as { intent: IntentSpec; signer: string };
    expect(params.signer).toBe("human");
    expect(params.intent).toMatchObject({
      kind: "task.create",
      title: "Add a dark mode toggle",
      repo: "app",
      mode: "solo",
      owner: "vps.coding",
    });
  });

  it("prints rejected with #seq and exits 3", async () => {
    const { home } = await daemon({ status: "rejected", seq: 9, reason: "unauthorized" });
    const cap = capture(home);
    const code = await runCli(["--machine", "task", "cancel", TASK, "--reason", "stop"], cap.ctx);
    expect(code).toBe(3);
    expect(cap.stderr).toBe("");
    expect(jsonLine(cap.stdout)).toEqual({
      ok: true,
      result: { status: "rejected", seq: 9, reason: "unauthorized" },
    });
  });

  it("prints dropped with no seq when the intent no longer applies", async () => {
    const { home } = await daemon({ status: "dropped", eventId: "evt_y" });
    const cap = capture(home);
    const code = await runCli(["lease", "revoke", TASK, "W1", "--epoch", "2"], cap.ctx);
    expect(code).toBe(3);
    expect(cap.stdout).toBe("dropped\n");
  });

  it("sends the plan decision, the replan and the escalation the flags describe", async () => {
    const { home, seen } = await daemon({ status: "accepted", seq: 1 });
    const cap = capture(home);
    expect(await runCli(["plan", "approve", TASK, "--note", "ship it"], cap.ctx)).toBe(0);
    expect(await runCli(["plan", "reject", TASK], cap.ctx)).toBe(0);
    expect(
      await runCli(
        ["replan", TASK, "--reason", "approach fails", "--evidence", "notes.txt"],
        cap.ctx,
      ),
    ).toBe(0);
    expect(
      await runCli(["decide", TASK, "--owner", "mac.coding", "--note", "handover"], cap.ctx),
    ).toBe(0);
    const intents = seen.map((call) => (call.params as { intent: IntentSpec }).intent);
    expect(intents).toEqual([
      { kind: "plan.approve", task: TASK, note: "ship it" },
      { kind: "plan.reject", task: TASK },
      { kind: "replan.request", task: TASK, reason: "approach fails\nfiles: notes.txt" },
      {
        kind: "decide",
        task: TASK,
        decision: "reassign_owner",
        new_owner: "mac.coding",
        note: "handover",
      },
    ]);
  });

  it("starts and stops a slot through the daemon, and refuses when none is listening", async () => {
    const { home, seen } = await daemon({ status: "accepted", seq: 1 });
    const cap = capture(home);
    expect(await runCli(["agent", "start", "--role-dir", "roles/coding"], cap.ctx)).toBe(0);
    expect(cap.stdout).toContain("started");
    expect(seen[0]?.params).toMatchObject({ role_dir: expect.stringMatching(/roles\/coding$/) });

    const absent = capture(
      await mkdtemp(join(tmpdir(), "skep-cli-absent-")).then((dir) => {
        dirs.push(dir);
        return dir;
      }),
    );
    const code = await runCli(["agent", "stop"], absent.ctx);
    expect(code).toBe(1);
    expect(absent.stderr).toMatch(/skepd is not running/);
  });

  it("reports a daemon error instead of a verdict", async () => {
    const home = await mkdtemp(join(tmpdir(), "skep-cli-write-"));
    dirs.push(home);
    server = new IpcServer({
      socketPath: skepPaths(home).socket,
      redactor: new Redactor(),
      handlers: {
        status: async () => ({}),
        log: async () => ({}),
        publish: async () => Promise.reject(new Error("blackboard unreachable")),
        agentStart: async () => ({}),
        agentStop: async () => ({}),
        logsTail: async () => ({}),
        doctor: async () => ({}),
        ping: async () => ({}),
      },
    });
    await server.start();
    const cap = capture(home);
    const code = await runCli(["--machine", "decide", TASK, "--cancel"], cap.ctx);
    expect(code).toBe(1);
    const body = jsonLine(cap.stdout);
    expect(body.ok).toBe(false);
    expect((body.error as { message: string }).message).toContain("blackboard unreachable");
  });
});

describe("write commands in-process when the daemon is down", () => {
  const git = new NodeGitRunner();
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A temp home with a device.toml, a human key, a trust root and a genesis blackboard. */
  async function home(): Promise<{ dir: string; signer: SshKeySigner }> {
    const dir = await mkdtemp(join(tmpdir(), "skep-cli-fallback-"));
    dirs.push(dir);
    const paths = skepPaths(dir);
    const key = await generateKey(join(dir, "keys"), "human");
    const daemonKey = await generateKey(join(dir, "keys"), "mac");
    await writeAllowedSigners(paths.allowedSigners, [
      { principal: "human", pubLine: key.pubLine },
      { principal: "daemon:mac", pubLine: daemonKey.pubLine },
    ]);
    const remote = join(dir, "remote.git");
    await initRepo(remote, { bare: true });
    // Genesis is bootstrapped from a throwaway clone, exactly as `skep init --genesis` writes the
    // daemon's clone rather than the CLI's. The CLI clone is created by the fallback itself.
    const bootstrap = new BlackboardClone({
      git,
      dir: join(dir, "bootstrap"),
      remoteUrl: remote,
    });
    const signer = new SshKeySigner({ principal: "human", keyPath: key.privPath });
    await createGenesis({
      git,
      clone: bootstrap,
      signer,
      genesis: genesisDoc(),
      allowedSignersText: `daemon:mac namespaces="git" ${daemonKey.pubLine}\n`,
      ident: {
        name: "Human",
        email: "human@example.invalid",
        timestampSec: 1_791_158_400,
        tz: "+0000",
      },
    });
    await writeFile(
      paths.deviceToml,
      [
        'schema = "skep.device/v1"',
        'device = "mac"',
        "repos = []",
        `signing_key = ${JSON.stringify(daemonKey.privPath)}`,
        `human_signing_key = ${JSON.stringify(key.privPath)}`,
        "",
        "[blackboard]",
        `url = ${JSON.stringify(remote)}`,
        "",
      ].join("\n"),
    );
    return { dir, signer };
  }

  it("accepts a cancel against the local clone and prints its #seq", async () => {
    const { dir, signer } = await home();
    const paths = skepPaths(dir);
    // The daemon key registers the agent and the human creates the task, the same way the two
    // publishers would have; the cancel below is what the CLI then publishes on its own.
    const daemon = new SshKeySigner({
      principal: "daemon:mac",
      keyPath: join(dir, "keys", "mac"),
    });
    const clone = new BlackboardClone({
      git,
      dir: paths.cliBlackboardClone,
      remoteUrl: await blackboardUrl(paths.deviceToml),
    });
    await clone.init();
    const publisher = new Publisher({
      git,
      clone,
      signer: daemon,
      clock: systemClock,
      rng: cryptoRandom,
      state: fullReplaySource(git, clone.dir, paths.allowedSigners),
      ident: { name: "Skep Daemon", email: "skepd@example.invalid", timestampSec: 0, tz: "+0000" },
    });
    const registered = await publisher.publish(
      () =>
        draft(
          "agent.registered",
          null,
          "mac.coding",
          {
            role: "coding",
            agent_cli: "codex",
            cli_version: "0.0.0-test",
            capabilities: [],
            requires_local: [],
            max_parallel_items: 1,
          },
          {},
        ),
      { signer: daemon },
    );
    expect(registered.status).toBe("accepted");
    const created = intentFromSpec(
      {
        kind: "task.create",
        title: "Add a toggle",
        body: "Add a dark mode toggle.",
        repo: "app",
        mode: "solo",
        owner: "mac.coding",
      },
      { rng: cryptoRandom, nowMs: systemClock.nowMs() },
    );
    expect(created).not.toBeNull();
    const creation = await publisher.publish(created ?? (() => null), { signer });
    expect(creation.status).toBe("accepted");
    const taskId = await publishedTaskId(paths.cliBlackboardClone, creation.eventId);

    // The owner proposes a solo plan, which locks implicitly and waits for the human. `plan show`
    // must render it, and the approve below is the human's decision through the fallback path.
    const plan = soloPlan(taskId);
    const proposed = await publisher.publish(
      () =>
        draft(
          "plan.proposed",
          taskId,
          "mac.coding",
          {
            version: 1,
            parent_version: null,
            plan,
            plan_hash: contentHash(plan),
            base_commit: plan.base.commit,
            reviewers: [],
          },
          { task_rev: 1, owner_gen: 1 },
        ),
      { signer: daemon },
    );
    expect(proposed.status).toBe("accepted");

    const show = capture(dir);
    const showCode = await runCli(["plan", "show", taskId, "--diff"], show.ctx);
    expect(showCode).toBe(0);
    expect(show.stdout).toContain(`plan v1`);
    expect(show.stdout).toContain("awaiting_approval");
    expect(show.stdout).toContain("W1");
    expect(show.stdout).toContain("changes from parent");

    // A hash the human did not see is dropped, not decided against a different plan.
    const stale = capture(dir);
    const staleCode = await runCli(
      ["plan", "reject", taskId, "--hash", `sha256:${"ab".repeat(32)}`],
      stale.ctx,
    );
    expect(staleCode).toBe(3);
    expect(stale.stdout).toMatch(/^dropped/);

    const approved = capture(dir);
    const approveCode = await runCli(
      ["plan", "approve", taskId, "--note", "ship it"],
      approved.ctx,
    );
    expect(approveCode).toBe(0);
    expect(approved.stdout).toMatch(/^accepted #\d+ plan v1 \(sha256:[0-9a-f]{64}\)\n$/);

    // Cancelling the now-executing task is the CLI publishing against its own clone (ARCHITECTURE §3).
    const cap = capture(dir);
    const code = await runCli(["--machine", "task", "cancel", taskId, "--reason", "stop"], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");
    const body = jsonLine(cap.stdout);
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ status: "accepted" });
    expect((body.result as { seq: number }).seq).toBeGreaterThan(0);
  });

  it("publishes through the fallback when no CLI clone exists yet (B2)", async () => {
    const { dir } = await home();
    const clone = skepPaths(dir).cliBlackboardClone;
    // The home has device.toml, the trust root, the human key and a genesis remote — nothing else.
    await expect(access(clone)).rejects.toThrow();
    const cap = capture(dir);
    const code = await runCli(
      [
        "--machine",
        "task",
        "new",
        "Add a dark mode toggle",
        "--repo",
        "app",
        "--owner",
        "mac.coding",
      ],
      cap.ctx,
    );
    // No agent is registered, so the intent drops; the point is that the clone was created and the
    // publish ran, rather than failing because the directory did not exist.
    expect(code).toBe(3);
    expect(cap.stderr).toBe("");
    expect(jsonLine(cap.stdout)).toMatchObject({ ok: true, result: { status: "dropped" } });
    await expect(access(clone)).resolves.toBeUndefined();
  });

  it("fails with an actionable error when no daemon and no device.toml exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skep-cli-empty-"));
    dirs.push(dir);
    const cap = capture(dir);
    const code = await runCli(["task", "cancel", TASK, "--reason", "stop"], cap.ctx);
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/skepd is not running/);
    expect(cap.stdout).toBe("");
  });
});

/** A one-item solo plan, the smallest the reducer will lock and hand to the human. */
function soloPlan(taskId: string): Plan {
  const commit = "a".repeat(40);
  return {
    schema: "skep.plan/v1",
    task_id: taskId,
    version: 1,
    parent_version: null,
    base: { repo: "app", branch: "main", commit },
    mode: "solo",
    summary: "Add the toggle.",
    items: [
      {
        id: "W1",
        title: "Add the toggle",
        role: "coding",
        assignee: "mac.coding",
        depends_on: [],
        touches: ["src/toggle.ts"],
        risk: "normal",
        acceptance: [{ kind: "check", name: "unit" }],
      },
    ],
    stack_order: ["W1"],
    changes_from_parent: null,
  };
}

/** The blackboard url recorded in the device.toml the fixture wrote. */
async function blackboardUrl(deviceToml: string): Promise<string> {
  const text = await readFile(deviceToml, "utf8");
  const match = text.match(/^url = "(.*)"$/m);
  if (!match?.[1]) throw new Error("fixture device.toml has no blackboard url");
  return JSON.parse(`"${match[1]}"`) as string;
}

/** The task id of an event the publisher just appended, read back from the clone. */
async function publishedTaskId(cloneDir: string, eventId: string | undefined): Promise<string> {
  if (!eventId) throw new Error("publish result has no event id");
  const { readdir } = await import("node:fs/promises");
  for (const task of await readdir(join(cloneDir, "events"))) {
    const text = await readFile(join(cloneDir, "events", task, `${eventId}.json`), "utf8").catch(
      () => null,
    );
    if (text !== null) return task;
  }
  throw new Error(`event ${eventId} is not in the clone`);
}
