import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitFile,
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../../test/helpers/git-fixture.js";
import { heartbeatRef } from "../core/ids.js";
import { type Heartbeat, HeartbeatSchema } from "../core/schemas/heartbeat.js";
import { buildCommitText, writeSignedCommit, writeTreeFromIndex } from "../git/commit.js";
import { GitError, type GitRunner, type GitRunOptions, NodeGitRunner } from "../git/runner.js";
import { type Signer, SshKeySigner } from "../git/signer.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import {
  DuplicateDaemonError,
  type HeartbeatDraft,
  HeartbeatError,
  HeartbeatWriter,
  readHeartbeats,
} from "./heartbeat.js";

const agent = "mac.coding";
const ref = heartbeatRef(agent);
const devices = { "mac.coding": "mac", "vps.coding": "vps" };
const idle: HeartbeatDraft = {
  state: "idle",
  task_id: null,
  item: null,
  epoch: null,
  observed_main: null,
  runtime: "native",
};
const running: HeartbeatDraft = {
  ...idle,
  state: "running",
  task_id: "T-20261005-abcd",
  item: "W1",
  epoch: 1,
};
const valid: Heartbeat = {
  ...idle,
  schema: "skep.hb/v1",
  agent,
  boot_id: "b_abcd",
  n: 1,
  sent_at: "2026-10-05T00:00:00Z",
};

class RecordingGit implements GitRunner {
  readonly commands: string[][] = [];

  constructor(private readonly git: GitRunner) {}

  run(args: string[], opts: GitRunOptions) {
    this.commands.push([...args]);
    return this.git.run(args, opts);
  }
}

describe("signed heartbeat refs", () => {
  const git = new NodeGitRunner();
  let root: string;
  let repoDir: string;
  let remoteDir: string;
  let observerDir: string;
  let trustPath: string;
  let macSigner: SshKeySigner;
  let vpsSigner: SshKeySigner;
  let humanSigner: SshKeySigner;
  let unknownSigner: SshKeySigner;
  let main: string;
  let time: VirtualTime;
  let clock: FakeClock;

  beforeAll(async () => {
    root = await tempDir("heartbeat-");
    vi.stubEnv("HOME", root);
    vi.stubEnv("SKEP_HOME", root);
    const mac = await generateKey(root, "mac");
    const vps = await generateKey(root, "vps");
    const human = await generateKey(root, "human");
    const unknown = await generateKey(root, "unknown");
    macSigner = new SshKeySigner({ principal: "daemon:mac", keyPath: mac.privPath });
    vpsSigner = new SshKeySigner({ principal: "daemon:vps", keyPath: vps.privPath });
    humanSigner = new SshKeySigner({ principal: "human", keyPath: human.privPath });
    unknownSigner = new SshKeySigner({ principal: "daemon:mac", keyPath: unknown.privPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [
      { principal: "daemon:mac", pubLine: mac.pubLine },
      { principal: "daemon:vps", pubLine: vps.pubLine },
      { principal: "human", pubLine: human.pubLine },
    ]);
  });

  beforeEach(async () => {
    const testDir = await mkdtemp(join(root, "case-"));
    repoDir = join(testDir, "writer");
    remoteDir = join(testDir, "remote.git");
    observerDir = join(testDir, "observer");
    await initRepo(remoteDir, { bare: true });
    await initRepo(repoDir);
    await initRepo(observerDir);
    await git.run(["remote", "add", "origin", remoteDir], { cwd: repoDir });
    await git.run(["remote", "add", "origin", remoteDir], { cwd: observerDir });
    main = await commitFile(git, repoDir, "initial.txt", "initial\n", macSigner);
    await git.run(["push", "origin", `${main}:refs/heads/main`], { cwd: repoDir });
    time = new VirtualTime();
    clock = new FakeClock(time, { wallStartMs: Date.parse("2026-10-05T00:00:00Z") });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function writer(overrides: Partial<ConstructorParameters<typeof HeartbeatWriter>[0]> = {}) {
    return new HeartbeatWriter({
      git,
      repoDir,
      agent,
      signer: macSigner,
      clock,
      bootId: "b_abcd",
      onAlarm: vi.fn(),
      ...overrides,
    });
  }

  async function fetch() {
    await git.run(
      [
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/hb/*:refs/remotes/origin/hb/*",
      ],
      { cwd: observerDir },
    );
  }

  async function tip(name = ref, dir = remoteDir) {
    return (await git.run(["rev-parse", "--verify", name], { cwd: dir })).stdout.trim();
  }

  async function makeCommit(
    content: string | Uint8Array,
    opts: { signer?: Signer | null; parents?: string[]; extra?: boolean; mode?: string } = {},
  ) {
    const blob = (
      await git.run(["hash-object", "-t", "blob", "-w", "--stdin"], {
        cwd: repoDir,
        input: content,
      })
    ).stdout.trim();
    const tree = (
      await git.run(["mktree"], {
        cwd: repoDir,
        input: `${opts.mode ?? "100644"} blob ${blob}\thb.json\n${opts.extra ? `100644 blob ${blob}\textra.json\n` : ""}`,
      })
    ).stdout.trim();
    const ident = {
      name: "Skep Test",
      email: "skep-test@example.invalid",
      timestampSec: 1_791_244_800,
      tz: "+0000",
    };
    const fields = {
      tree,
      parents: opts.parents ?? [],
      author: ident,
      committer: ident,
      message: "Heartbeat test\n",
    };
    return opts.signer === null
      ? (
          await git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
            cwd: repoDir,
            input: buildCommitText(fields),
          })
        ).stdout.trim()
      : writeSignedCommit(git, repoDir, { ...fields, signer: opts.signer ?? macSigner });
  }

  async function publish(oid: string, name = ref) {
    await git.run(["push", "--force", "origin", `${oid}:${name}`], { cwd: repoDir });
    await fetch();
  }

  it("publishes ten signed orphan beats without changing main, the index or worktree", async () => {
    await writeFile(join(repoDir, "pending.txt"), "pending\n");
    await git.run(["add", "pending.txt"], { cwd: repoDir });
    const beforeStatus = (await git.run(["status", "--porcelain"], { cwd: repoDir })).stdout;
    const beforeTree = await writeTreeFromIndex(git, repoDir);
    const recorded = new RecordingGit(git);
    const onAlarm = vi.fn();
    const heartbeat = writer({ git: recorded, onAlarm });
    const seen = new Set<string>();
    for (let n = 1; n <= 10; n++) {
      await heartbeat.beat({ ...running, observed_main: main });
      await fetch();
      const observation = (await readHeartbeats(git, observerDir, trustPath, devices))[agent];
      expect(observation).toMatchObject({
        problem: null,
        hb: {
          ...running,
          observed_main: main,
          schema: "skep.hb/v1",
          agent,
          boot_id: "b_abcd",
          n,
          sent_at: new Date(clock.nowMs()).toISOString().replace(".000Z", "Z"),
        },
      });
      expect(HeartbeatSchema.safeParse(observation?.hb).success).toBe(true);
      const oid = await tip();
      seen.add(oid);
      expect((await git.run(["rev-list", "--count", oid], { cwd: remoteDir })).stdout.trim()).toBe(
        "1",
      );
      expect((await git.run(["ls-tree", "--name-only", oid], { cwd: remoteDir })).stdout).toBe(
        "hb.json\n",
      );
      expect(await tip("refs/heads/main")).toBe(main);
      expect(await tip("refs/heads/main", repoDir)).toBe(main);
      await time.advance(60_000);
    }
    expect(seen.size).toBe(10);
    expect(await writeTreeFromIndex(git, repoDir)).toBe(beforeTree);
    expect((await git.run(["status", "--porcelain"], { cwd: repoDir })).stdout).toBe(beforeStatus);
    expect(onAlarm).not.toHaveBeenCalled();
    const pushes = recorded.commands.filter((args) => args[0] === "push");
    expect(pushes).toHaveLength(10);
    expect(pushes[0]).toContain(`--force-with-lease=${ref}:`);
    expect(
      pushes.every((args) => args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))),
    ).toBe(true);
    expect(recorded.commands.flat()).not.toContain("--force");
    for (const command of [
      "add",
      "write-tree",
      "reset",
      "checkout",
      "update-ref",
      "rebase",
      "merge",
      "pull",
    ]) {
      expect(recorded.commands.some((args) => args[0] === command)).toBe(false);
    }
  });

  it("serializes concurrent beats and increments the counter even at an unchanged wall time", async () => {
    const onAlarm = vi.fn();
    const heartbeat = writer({ onAlarm });
    await Promise.all([heartbeat.beat(idle), heartbeat.beat(running), heartbeat.beat(idle)]);
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb).toMatchObject({
      n: 3,
      state: "idle",
    });
    expect(onAlarm).not.toHaveBeenCalled();
  });

  it("adopts an existing ref on a stopped daemon's restart and resets the per-boot counter", async () => {
    const first = writer();
    await first.beat(idle);
    await first.beat(idle);
    await writer({ bootId: "b_dcba" }).beat(idle);
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb).toMatchObject({
      boot_id: "b_dcba",
      n: 1,
    });
    expect(await tip("refs/heads/main")).toBe(main);
  });

  it("alarms and refuses to overwrite a competing boot ID, including on subsequent beats", async () => {
    const onAlarm = vi.fn();
    const first = writer({ onAlarm });
    await first.beat(idle);
    const expectedOid = await tip();
    await writer({ bootId: "b_dcba" }).beat(running);
    const rivalOid = await tip();
    await expect(first.beat(idle)).rejects.toBeInstanceOf(DuplicateDaemonError);
    expect(onAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "duplicate-daemon",
        agent,
        bootId: "b_abcd",
        expectedOid,
        actualOid: rivalOid,
      }),
    );
    expect(await tip()).toBe(rivalOid);
    await expect(first.beat(idle)).rejects.toBeInstanceOf(DuplicateDaemonError);
    expect(await tip()).toBe(rivalOid);
  });

  it("detects an initial creation race with force-with-lease instead of clobbering the rival", async () => {
    const rival = await makeCommit(JSON.stringify({ ...valid, boot_id: "b_dcba" }));
    const run: GitRunner["run"] = async (args, opts) => {
      if (args[0] === "push") await publish(rival);
      return git.run(args, opts);
    };
    const onAlarm = vi.fn();
    await expect(writer({ git: { run }, onAlarm }).beat(idle)).rejects.toBeInstanceOf(
      DuplicateDaemonError,
    );
    expect(onAlarm).toHaveBeenCalledOnce();
    expect(await tip()).toBe(rival);
  });

  it("reconciles a lost push acknowledgement and keeps the next lease valid", async () => {
    let loseAck = true;
    const recorded = new RecordingGit({
      run: async (args, opts) => {
        const result = await git.run(args, opts);
        if (args[0] === "push" && loseAck) {
          loseAck = false;
          throw new GitError(args, -1, "Connection reset after remote update");
        }
        return result;
      },
    });
    const onAlarm = vi.fn();
    const heartbeat = writer({ git: recorded, onAlarm });
    await heartbeat.beat(idle);
    const firstOid = await tip();
    await heartbeat.beat(running);
    expect(recorded.commands.filter((args) => args[0] === "push")[1]).toContain(
      `--force-with-lease=${ref}:${firstOid}`,
    );
    expect(onAlarm).not.toHaveBeenCalled();
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb?.n).toBe(2);
  });

  it("reports a transport failure without alarming and lets a later beat recover", async () => {
    let fail = true;
    const run: GitRunner["run"] = async (args, opts) => {
      if (args[0] === "push" && fail) {
        fail = false;
        return { code: 1, stdout: "", stderr: "Remote unavailable" };
      }
      return git.run(args, opts);
    };
    const onAlarm = vi.fn();
    const heartbeat = writer({ git: { run }, onAlarm });
    await expect(heartbeat.beat(idle)).rejects.toThrow("retry after connectivity recovers");
    await heartbeat.beat(idle);
    expect(onAlarm).not.toHaveBeenCalled();
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb?.n).toBe(2);
  });

  it("still alarms on a definite lease rejection if reconciliation loses connectivity", async () => {
    let rejected = false;
    const run: GitRunner["run"] = async (args, opts) => {
      if (args[0] === "push") {
        rejected = true;
        return {
          code: 1,
          stdout: `!\t${ref}:${ref}\t[rejected] (stale info)\n`,
          stderr: "Push rejected",
        };
      }
      if (args[0] === "ls-remote" && rejected) throw new GitError(args, -1, "Remote unavailable");
      return git.run(args, opts);
    };
    const onAlarm = vi.fn();
    await expect(writer({ git: { run }, onAlarm }).beat(idle)).rejects.toThrow(
      DuplicateDaemonError,
    );
    expect(onAlarm).toHaveBeenCalledOnce();
  });

  it("detects two writers sharing a boot ID as well as writers with different boots", async () => {
    const onAlarm = vi.fn();
    const first = writer({ onAlarm });
    await first.beat(idle);
    await time.advance(60_000);
    await writer().beat(running);
    await expect(first.beat(idle)).rejects.toThrow(DuplicateDaemonError);
    expect(onAlarm).toHaveBeenCalledOnce();
  });

  it.each(["daemon:vps", "human"])("rejects writer principal %s for the agent", (principal) => {
    expect(() => writer({ signer: { principal, sign: vi.fn() } })).toThrow(HeartbeatError);
  });

  it("rejects malformed constructor and draft inputs before performing writes", async () => {
    const recorded = new RecordingGit(git);
    expect(() => writer({ agent: "mac.coding\n" })).toThrow(HeartbeatError);
    expect(() => writer({ bootId: "invalid" })).toThrow(HeartbeatError);
    expect(() => writer({ bootId: "b_abcd\n" })).toThrow(HeartbeatError);
    const heartbeat = writer({ git: recorded });
    await expect(heartbeat.beat({ ...idle, epoch: 0 })).rejects.toThrow(HeartbeatError);
    await expect(
      heartbeat.beat({ ...idle, provider: "invalid" } as HeartbeatDraft),
    ).rejects.toThrow(HeartbeatError);
    await expect(
      heartbeat.beat({ ...idle, agent: "vps.coding" } as HeartbeatDraft),
    ).rejects.toThrow(HeartbeatError);
    expect(recorded.commands).toEqual([]);
    await heartbeat.beat(idle);
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb?.n).toBe(1);
  });

  it("returns no observations when no heartbeat refs have been fetched", async () => {
    expect(await readHeartbeats(git, observerDir, trustPath, devices)).toEqual({});
  });

  it("reports another device's valid signature and still reads a valid peer", async () => {
    await publish(await makeCommit(JSON.stringify(valid), { signer: vpsSigner }));
    await writer({ agent: "vps.coding", signer: vpsSigner }).beat(idle);
    await fetch();
    const observations = await readHeartbeats(git, observerDir, trustPath, devices);
    expect(observations[agent]).toMatchObject({
      hb: null,
      problem: expect.stringContaining("does not own agent"),
    });
    expect(observations["vps.coding"]).toMatchObject({
      problem: null,
      hb: { agent: "vps.coding" },
    });
  });

  it.each(["human", "unknown", "unsigned"])("rejects %s signatures", async (kind) => {
    const signer = kind === "human" ? humanSigner : kind === "unknown" ? unknownSigner : null;
    await publish(await makeCommit(JSON.stringify(valid), { signer }));
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]).toMatchObject({
      hb: null,
      problem: expect.any(String),
    });
  });

  it("rejects a tampered heartbeat signature", async () => {
    const good = await makeCommit(JSON.stringify(valid));
    const object = (await git.run(["cat-file", "commit", good], { cwd: repoDir })).stdout;
    const bad = (
      await git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
        cwd: repoDir,
        input: object.replace("Heartbeat test", "Tampered heartbeat"),
      })
    ).stdout.trim();
    await publish(bad);
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.problem).toContain(
      "signature is bad",
    );
  });

  it("rejects a signed heartbeat with a parent even if replacement refs hide that parent", async () => {
    const orphan = await makeCommit(JSON.stringify(valid));
    const child = await makeCommit(JSON.stringify(valid), { parents: [orphan] });
    await publish(child);
    await git.run(["fetch", "origin", orphan], { cwd: observerDir });
    await git.run(["replace", child, orphan], { cwd: observerDir });
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.problem).toContain(
      "must be an orphan",
    );
  });

  it.each([
    ["invalid JSON", "not JSON", "valid JSON"],
    ["unknown keys", JSON.stringify({ ...valid, extra: true }), "skep.hb/v1"],
    ["invalid schema", JSON.stringify({ ...valid, schema: "skep.hb/v2" }), "skep.hb/v1"],
    ["agent mismatch", JSON.stringify({ ...valid, agent: "vps.coding" }), "does not match its ref"],
    ["invalid counter", JSON.stringify({ ...valid, n: -1 }), "skep.hb/v1"],
  ])("rejects %s content", async (_label, content, problem) => {
    await publish(await makeCommit(content));
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]).toMatchObject({
      hb: null,
      problem: expect.stringContaining(problem),
    });
  });

  it.each([{ extra: true }, { mode: "120000" }])(
    "rejects non-protocol tree entries: %j",
    async (opts) => {
      await publish(await makeCommit(JSON.stringify(valid), opts));
      expect(
        (await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.problem,
      ).toContain("only the hb.json blob");
    },
  );

  it("rejects oversized blobs before reading their body", async () => {
    const oversized = `${JSON.stringify(valid)}${" ".repeat(64 * 1024)}`;
    await publish(await makeCommit(oversized));
    const recorded = new RecordingGit(git);
    expect(
      (await readHeartbeats(recorded, observerDir, trustPath, devices))[agent]?.problem,
    ).toContain("64 KiB");
    expect(recorded.commands.some((args) => args.includes("blob"))).toBe(false);
  });

  it("rejects invalid UTF-8 rather than validating lossy signed content", async () => {
    const malformed = Buffer.concat([
      Buffer.from(JSON.stringify(valid).replace("b_abcd", "b_")),
      Buffer.from([0xff]),
    ]);
    await publish(await makeCommit(malformed));
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.problem).toContain(
      "valid UTF-8",
    );
  });

  it("rejects unregistered refs and mismatched device registrations", async () => {
    await publish(await makeCommit(JSON.stringify(valid)));
    expect((await readHeartbeats(git, observerDir, trustPath, {}))[agent]?.problem).toContain(
      "not registered",
    );
    expect(
      (await readHeartbeats(git, observerDir, trustPath, { [agent]: "vps" }))[agent]?.problem,
    ).toContain("does not own agent");
  });

  it("uses only the supplied local trust root despite hostile repository trust config", async () => {
    await publish(await makeCommit(JSON.stringify(valid), { signer: unknownSigner }));
    await git.run(["config", "gpg.ssh.allowedSignersFile", trustPath], { cwd: observerDir });
    expect(
      (await readHeartbeats(git, observerDir, join(root, "missing-signers"), devices))[agent]
        ?.problem,
    ).toContain("unknown_key");
  });

  it("prefers fetched refs over stale local heads and also reads bare repositories", async () => {
    const old = await makeCommit(JSON.stringify({ ...valid, n: 0 }));
    await publish(old);
    await git.run(["update-ref", ref, old], { cwd: observerDir });
    await writer().beat(idle);
    await fetch();
    expect((await readHeartbeats(git, observerDir, trustPath, devices))[agent]?.hb?.n).toBe(1);
    expect((await readHeartbeats(git, remoteDir, trustPath, devices))[agent]?.hb?.n).toBe(1);
  });

  it("reports unavailable commit objects per ref", async () => {
    await writer().beat(idle);
    await fetch();
    const run: GitRunner["run"] = async (args, opts) => {
      if (args.includes("commit") && args.includes("cat-file"))
        throw new GitError(args, 128, "Missing commit object");
      return git.run(args, opts);
    };
    expect(
      (await readHeartbeats({ run }, observerDir, trustPath, devices))[agent]?.problem,
    ).toContain("Missing commit object");
  });
});

describe("heartbeat boundary errors", () => {
  it.each(["invalid", `${"a".repeat(40)}\0unexpected\n`])(
    "rejects malformed ref enumeration: %j",
    async (stdout) => {
      const git: GitRunner = { run: vi.fn(async () => ({ code: 0, stdout, stderr: "" })) };
      await expect(readHeartbeats(git, "/repo", "/repo/allowed_signers", devices)).rejects.toThrow(
        HeartbeatError,
      );
    },
  );

  it("wraps enumeration failures in an actionable typed error", async () => {
    const git: GitRunner = {
      run: vi.fn(async () => {
        throw new Error("Cannot access repository");
      }),
    };
    await expect(readHeartbeats(git, "/repo", "/repo/allowed_signers", devices)).rejects.toThrow(
      "fetch the blackboard and retry",
    );
  });
});
