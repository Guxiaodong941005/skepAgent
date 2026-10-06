import { describe, expect, it, vi } from "vitest";
import { GitError, type GitRunner } from "../git/runner.js";
import { FakeClock, VirtualTime } from "./fake-clock.js";
import { FaultConfigurationError, FaultyGitRunner, type GitFault } from "./faulty-git.js";
import { Rng } from "./rng.js";

const opts = { cwd: ".skep-sim/unused" };
const ok = { code: 0, stdout: "ok", stderr: "" };

function setup(fault?: GitFault) {
  const time = new VirtualTime();
  const clock = new FakeClock(time);
  const run = vi.fn<GitRunner["run"]>().mockResolvedValue(ok);
  const git = new FaultyGitRunner({ git: { run }, clock, script: fault ? [{ fault }] : [] });
  return { git, run, clock, time };
}

describe("FaultyGitRunner", () => {
  it("fails a fetch before calling git, consumes the script, and preserves local commands", async () => {
    const { git, run } = setup({ kind: "failed-fetch" });
    expect(await git.run(["rev-parse", "HEAD"], opts)).toEqual(ok);
    await expect(git.run(["fetch", "origin"], opts)).rejects.toThrow(GitError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await git.run(["fetch", "origin"], opts)).toEqual(ok);
    expect(git.history).toEqual([{ kind: "failed-fetch", command: "fetch", occurrence: 1 }]);
  });

  it("returns a failure result when allowFailure is set", async () => {
    const { git } = setup({ kind: "failed-fetch" });
    expect(await git.run(["fetch", "origin"], { ...opts, allowFailure: true })).toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("fetch failure"),
    });
  });

  it("executes the competing push before our real push, leaving non-ff arbitration to git", async () => {
    const order: string[] = [];
    const { git, run } = setup({
      kind: "competing-push",
      push: async (raw, args, passedOpts) => {
        order.push("rival");
        expect(args).toEqual(["push", "origin", "pending:refs/heads/main"]);
        expect(passedOpts).toEqual(opts);
        await raw.run(["push", "origin", "rival:refs/heads/main"], opts);
      },
    });
    run.mockImplementation(async (args) => {
      order.push(args[2] ?? "");
      if (args[2]?.startsWith("pending")) throw new GitError(args, 1, "non-fast-forward");
      return ok;
    });
    await expect(git.run(["push", "origin", "pending:refs/heads/main"], opts)).rejects.toThrow(
      "non-fast-forward",
    );
    expect(order).toEqual(["rival", "rival:refs/heads/main", "pending:refs/heads/main"]);
  });

  it("loses the acknowledgement only after a successful real push", async () => {
    const { git, run } = setup({ kind: "lost-ack" });
    await expect(
      git.run(["push", "origin", "pending:refs/heads/main"], opts),
    ).rejects.toMatchObject({
      code: -1,
      stderr: expect.stringContaining("lost push acknowledgement"),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(await git.run(["push", "origin"], opts)).toEqual(ok);
  });

  it("preserves the actual failed push result instead of inventing a lost ack", async () => {
    const { git, run } = setup({ kind: "lost-ack" });
    const rejected = { code: 1, stdout: "", stderr: "non-fast-forward" };
    run.mockResolvedValue(rejected);
    expect(await git.run(["push", "origin"], { ...opts, allowFailure: true })).toEqual(rejected);
  });

  it("delays through the injected clock and performs no git I/O before its timer", async () => {
    const { git, run, time } = setup({ kind: "delay", ms: 100 });
    const pending = git.run(["fetch", "origin"], opts);
    expect(run).not.toHaveBeenCalled();
    await time.advance(99);
    expect(run).not.toHaveBeenCalled();
    await time.advance(1);
    expect(await pending).toEqual(ok);
  });

  it("partitions all remote operations until explicitly healed while local verification works", async () => {
    const { git, run } = setup({ kind: "partition" });
    for (const command of ["fetch", "push", "ls-remote"]) {
      await expect(git.run([command, "origin"], opts)).rejects.toThrow("partition");
    }
    expect(run).not.toHaveBeenCalled();
    expect(await git.run(["--no-replace-objects", "cat-file", "commit", "HEAD"], opts)).toEqual(ok);
    git.setPartitioned(false);
    expect(await git.run(["fetch", "origin"], opts)).toEqual(ok);
  });

  it("heals timed partitions on monotonic time, ignoring wall skew and suspension", async () => {
    const { git, clock, time } = setup({ kind: "partition", ms: 100 });
    await expect(git.run(["fetch", "origin"], opts)).rejects.toThrow("partition");
    clock.setSkew(100_000);
    clock.suspend();
    await time.advance(1_000);
    await expect(git.run(["push", "origin"], opts)).rejects.toThrow("partition");
    clock.resume();
    await time.advance(100);
    expect(await git.run(["fetch", "origin"], opts)).toEqual(ok);
  });

  it("targets a scripted command occurrence even with leading git configuration flags", async () => {
    const { git } = setup();
    git.inject({ occurrence: 2, fault: { kind: "failed-fetch" } });
    expect(await git.run(["-c", "test.value=push", "fetch", "origin"], opts)).toEqual(ok);
    await expect(git.run(["fetch", "origin"], opts)).rejects.toThrow("fetch failure");
  });

  it("reproduces seeded faults without coupling them to local git calls", async () => {
    async function history(localCalls: boolean) {
      const time = new VirtualTime();
      const git = new FaultyGitRunner({
        git: { run: async () => ok },
        clock: new FakeClock(time),
        seeded: {
          rng: new Rng(42),
          fetchFailureRate: 0.5,
          lostAckRate: 0.5,
          delayRate: 0.3,
          delayMs: 1,
        },
      });
      for (let i = 0; i < 20; i++) {
        if (localCalls) await git.run(["rev-parse", "HEAD"], opts);
        const pending = git.run([i % 2 ? "push" : "fetch", "origin"], {
          ...opts,
          allowFailure: true,
        });
        await time.advance(1);
        await pending;
      }
      return git.history;
    }
    const first = await history(false);
    expect(first.length).toBeGreaterThan(0);
    expect(await history(true)).toEqual(first);
  });

  it("rejects invalid fault configuration", () => {
    const { clock } = setup();
    const git = { run: async () => ok };
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new FaultyGitRunner({ git, clock, script: [{ fault: { kind: "delay", ms } }] }),
      ).toThrow(FaultConfigurationError);
    }
    expect(
      () => new FaultyGitRunner({ git, clock, seeded: { rng: new Rng(1), fetchFailureRate: 2 } }),
    ).toThrow("probability");
    expect(
      () => new FaultyGitRunner({ git, clock, seeded: { rng: new Rng(1), competingPushRate: 1 } }),
    ).toThrow("callback");
  });
});
