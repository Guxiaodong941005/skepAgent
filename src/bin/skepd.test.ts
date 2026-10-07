import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { T1 } from "../../test/helpers/log-builder.js";
import { GhCodeHost } from "../codehost/gh.js";
import type { CodeHost } from "../codehost/types.js";
import { sha256Hex } from "../core/canonical.js";
import * as intentModule from "../core/intent-spec.js";
import type { DeviceConfig } from "../core/schemas/config.js";
import type { Evidence } from "../core/schemas/evidence.js";
import type { Review } from "../core/schemas/review.js";
import { IpcServer } from "../daemon/ipc-server.js";
import { EvidenceVerifier } from "../exec/evidence.js";
import type { JournalRecord } from "../exec/journal.js";
import { Redactor } from "../exec/redact.js";
import { execFileChecked } from "../util/exec.js";
import {
  bindAgentRuntime,
  bindCodeHost,
  type DaemonBootstrapOptions,
  runDaemon,
  verifyReviewEvidence,
} from "./skepd.js";

describe("daemon entrypoint", () => {
  it("hands CLI schema and output scratch access to the configured OS user", async () => {
    const root = await mkdtemp(join(process.cwd(), ".skep-runtime-test-"));
    try {
      const capture = join(root, "invocation", "capture");
      await mkdir(capture, { recursive: true, mode: 0o700 });
      const schema = join(capture, "schema.json");
      await writeFile(schema, "{}", { mode: 0o600 });
      const spawn = vi.fn(async () => ({
        pid: 101,
        pgid: 101,
        startToken: "test",
        wait: async () => ({ code: 0, signal: null }),
        signalGroup: () => {},
      }));
      const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
      const runtime = bindAgentRuntime(
        { name: "native", spawn, isAlive: async () => true },
        identity,
        root,
      );
      await runtime.spawn({
        argv: [
          "codex",
          "--output-schema",
          schema,
          "--output-last-message",
          join(capture, "last.json"),
        ],
        cwd: root,
        env: { PATH: "agent-bin" },
        logPath: join(root, "output.log"),
      });
      expect((await stat(schema)).mode & 0o777).toBe(0o640);
      expect((await stat(capture)).mode & 0o777).toBe(0o770);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining(identity));
      await expect(
        runtime.spawn({
          argv: ["codex", "--output-last-message", join(root, "..", "outside.json")],
          cwd: root,
          env: {},
          logPath: join(root, "output.log"),
        }),
      ).rejects.toThrow("invocation directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("prints daemon flags without loading device config", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runDaemon(["--help"], { SKEP_HOME: ".skep-sim/home" });
      expect(write.mock.calls.map(([text]) => text).join("")).toContain("--agent-path");
      expect(write.mock.calls.map(([text]) => text).join("")).toContain("--socket-group <name>");
    } finally {
      write.mockRestore();
    }
  });
  it("requires an explicit local user, home and PATH before starting a slot", async () => {
    await expect(runDaemon(["--role-dir", ".skep-sim/role"], {})).rejects.toThrow(
      "--agent-user, --agent-home and --agent-path",
    );
  });
  it("wires the merged intent resolver and IPC server through runDaemon", async () => {
    const resolve = vi.spyOn(intentModule, "intentFromSpec");
    const interrupted = new Error("Stop before starting native I/O");
    const stop = vi.fn(async () => {});
    const bootstrap = vi.fn(async (options: DaemonBootstrapOptions) => {
      const spec = { kind: "task.cancel", task: T1, reason: "Cancel the example task" };
      const intent = options.resolveIntent(spec);
      expect(intent).toBeTypeOf("function");
      expect(resolve).toHaveBeenCalledWith(spec, {
        rng: options.random,
        nowMs: expect.any(Number),
      });
      const handlers = {
        status: vi.fn(),
        log: vi.fn(),
        publish: vi.fn(),
        agentStart: vi.fn(),
        agentStop: vi.fn(),
        logsTail: vi.fn(),
        doctor: vi.fn(),
        ping: vi.fn(),
        pull: vi.fn(),
      };
      const server = options.ipcFactory({
        socketPath: join(options.home, "skepd.sock"),
        handlers,
        redactor: new Redactor(),
      });
      expect(server).toBeInstanceOf(IpcServer);
      return {
        start: async () => {
          throw interrupted;
        },
        stop,
      };
    });
    try {
      await expect(runDaemon(["--home", ".skep-sim/home"], {}, bootstrap)).rejects.toBe(
        interrupted,
      );
      expect(bootstrap).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      resolve.mockRestore();
    }
  });
  it.each([false, true])("applies CLI socket permissions with group flag = %s", async (shared) => {
    const home = await mkdtemp(join(tmpdir(), "skep-socket-cli-"));
    const group = (await execFileChecked("/usr/bin/id", ["-gn"])).stdout.trim();
    const interrupted = new Error("Stop after checking socket permissions");
    const bootstrap = async (options: DaemonBootstrapOptions) => {
      const socketPath = join(options.home, "skepd.sock");
      const server = options.ipcFactory({
        socketPath,
        redactor: new Redactor(),
        handlers: {
          status: vi.fn(),
          log: vi.fn(),
          publish: vi.fn(),
          agentStart: vi.fn(),
          agentStop: vi.fn(),
          logsTail: vi.fn(),
          doctor: vi.fn(),
          ping: vi.fn(),
          pull: vi.fn(),
        },
      });
      return {
        start: async () => {
          await server.start();
          expect((await stat(socketPath)).mode & 0o777).toBe(shared ? 0o660 : 0o600);
          expect((await stat(home)).mode & 0o777).toBe(shared ? 0o750 : 0o700);
          expect((await stat(socketPath)).gid).toBe(process.getgid?.());
          expect((await stat(home)).gid).toBe(process.getgid?.());
          throw interrupted;
        },
        stop: () => server.stop(),
      };
    };
    try {
      await expect(
        runDaemon(["--home", home, ...(shared ? ["--socket-group", group] : [])], {}, bootstrap),
      ).rejects.toBe(interrupted);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("configures the Mac LaunchDaemon example for the skep socket group", async () => {
    const plist = await readFile(
      new URL("../../deploy/com.skepagent.skepd.plist", import.meta.url),
      "utf8",
    );
    const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    expect(args).toMatch(/<string>--socket-group<\/string>\s*<string>skep<\/string>/);
    expect(plist).toContain("A non-root CLI outside that group is denied by the OS");
  });
});

describe("daemon code host repository binding", () => {
  function config(url: string): DeviceConfig {
    return {
      schema: "skep.device/v1",
      device: "mac",
      blackboard: { url: "https://example.invalid/blackboard.git" },
      repos: [{ name: "app", url }],
      signing_key: "daemon.key",
      poll: { active_sec: 20, idle_sec: 90 },
    };
  }
  it.each([
    "git@example.com:owner/repo.git",
    "https://example.com/owner/repo.git",
    "ssh://git@example.com/owner/repo.git",
  ])("resolves an allowlisted alias and %s to gh's hostname and owner/repo", async (url) => {
    const run = vi.fn(async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ object: { sha: "a".repeat(40) } }),
      stderr: "",
    }));
    const host = bindCodeHost(new GhCodeHost({ run, env: {} }), config(url));
    expect(await host.remoteBranchSha("app", "main")).toBe("a".repeat(40));
    expect(run).toHaveBeenCalledWith(
      "gh",
      ["api", "--hostname", "example.com", "repos/owner/repo/git/ref/heads/main"],
      expect.objectContaining({ env: {} }),
    );
    expect(await host.remoteBranchSha(url, "main")).toBe("a".repeat(40));
    await expect(host.remoteBranchSha("other", "main")).rejects.toThrow("local allowlist");
  });
  it("normalizes every PR operation and permits an allowlisted owner/repo name", async () => {
    const backend: CodeHost = {
      remoteBranchSha: vi.fn(),
      findPr: vi.fn(),
      createPr: vi.fn(),
      retargetPr: vi.fn(),
      closePr: vi.fn(),
      prState: vi.fn(),
    };
    const host = bindCodeHost(backend, config("git@example.com:owner/repo.git"));
    const params = { head: "work", base: "main", title: "Example change", body: "Example body" };
    await host.findPr("app", "work");
    await host.createPr("app", params);
    await host.retargetPr("app", 1, "main");
    await host.closePr("app", 1, "Stale epoch");
    await host.prState("app", 1);
    expect(backend.findPr).toHaveBeenCalledWith("https://example.com/owner/repo", "work");
    expect(backend.createPr).toHaveBeenCalledWith("https://example.com/owner/repo", params);
    expect(backend.retargetPr).toHaveBeenCalledWith("https://example.com/owner/repo", 1, "main");
    expect(backend.closePr).toHaveBeenCalledWith(
      "https://example.com/owner/repo",
      1,
      "Stale epoch",
    );
    expect(backend.prState).toHaveBeenCalledWith("https://example.com/owner/repo", 1);
    await bindCodeHost(backend, config("owner/repo.git")).findPr("app", "work");
    expect(backend.findPr).toHaveBeenLastCalledWith("owner/repo", "work");
  });
  it.each([
    "http://example.com/owner/repo.git",
    "https://example.com/owner/repo.git?ref=main",
    "https://example.com/owner",
  ])("fails closed for an unsupported code host remote %s", async (url) => {
    const run = vi.fn();
    const host = bindCodeHost(new GhCodeHost({ run }), config(url));
    await expect(host.remoteBranchSha("app", "main")).rejects.toThrow("Code host URLs");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("daemon review evidence", () => {
  function review(evidence: Evidence[]): Review {
    return {
      schema: "skep.review/v1",
      plan_version: 2,
      plan_hash: `sha256:${"a".repeat(64)}`,
      verdict: "block",
      blockers: [{ id: "B1", claim: "A trusted check failed", evidence }],
      suggestions: [],
    };
  }
  const run = {
    run_id: "local-check",
    sha: "b".repeat(40),
    check: "unit",
    exit: 1,
    duration_ms: 12,
    log_sha256: "c".repeat(64),
    argv_sha256: "d".repeat(64),
  };
  const check: Evidence = {
    id: "ev_check",
    type: "check_run",
    run_id: run.run_id,
    sha: run.sha,
    check: run.check,
    exit: run.exit,
    log_sha256: run.log_sha256,
  };
  const command: Evidence = {
    id: "ev_command",
    type: "command_run",
    run_id: run.run_id,
    sha: run.sha,
    exit: run.exit,
    log_sha256: run.log_sha256,
    argv_sha256: run.argv_sha256,
  };
  it.each([
    { item: "W2", epoch: 3 },
    { item: "W1", epoch: 2 },
    { item: "W2", epoch: 1 },
  ])("preserves local check and command evidence from $item epoch $epoch", async (attempt) => {
    const record: JournalRecord = {
      ...run,
      step: "check_run",
      ts_mono: 0,
      ts_wall: "2026-10-05T00:00:00Z",
    };
    const read = vi.fn(async (key: { task: string; item: string; epoch: number }) =>
      key.task === T1 && key.item === attempt.item && key.epoch === attempt.epoch ? [record] : [],
    );
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: { read },
    });
    const result = await verifyReviewEvidence(
      review([check, command, { ...check, id: "ev_unknown", run_id: "remote-check" }]),
      { task_id: T1, epochs: { W1: 2, W2: 3 } },
      verifier,
    );
    expect(result.verdict).toBe("block");
    expect(result.blockers[0]?.evidence).toEqual([check, command]);
    expect(read).toHaveBeenCalledWith({ task: T1, ...attempt });
  });
  it("downgrades a block when no local attempt verifies its evidence", async () => {
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: { read: async () => [] },
    });
    const result = await verifyReviewEvidence(
      review([check]),
      { task_id: T1, epochs: { W2: 3 } },
      verifier,
    );
    expect(result.verdict).toBe("comment");
    expect(result.blockers).toEqual([]);
  });
  it("verifies file evidence before the task has any claimed attempts", async () => {
    const read = vi.fn();
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn(async () => ({ code: 0, stdout: "pinned text\n", stderr: "" })) },
      mirror: { mirrorPath: async () => process.cwd() },
      journal: { read },
    });
    const input = review([
      {
        id: "ev_file",
        type: "file_span",
        repo: "https://example.invalid/code.git",
        commit: run.sha,
        path: "src/example.ts",
        lines: [1, 1],
        sha256: sha256Hex("pinned text"),
      },
    ]);
    expect(await verifyReviewEvidence(input, { task_id: T1, epochs: {} }, verifier)).toEqual(input);
    expect(read).not.toHaveBeenCalled();
  });
});
