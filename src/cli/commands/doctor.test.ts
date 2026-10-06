import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey, initRepo, writeAllowedSigners } from "../../../test/helpers/git-fixture.js";
import { genesisDoc } from "../../../test/helpers/log-builder.js";
import { BlackboardClone } from "../../blackboard/clone.js";
import { createGenesis } from "../../blackboard/genesis.js";
import { skepPaths } from "../../config/paths.js";
import { NodeGitRunner } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import type { Clock } from "../../util/clock.js";
import type { ExecResult } from "../../util/exec.js";
import type { CliContext } from "../context.js";
import { createOutput, EXIT } from "../output.js";
import { runCli } from "../program.js";
import { type DoctorDeps, type DoctorReport, register, runDoctor } from "./doctor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-doctor-"));
  roots.push(dir);
  return dir;
}

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDoctorTestKeyMaterialOnlyNotASecret skepd";

async function writeDevice(dir: string): Promise<void> {
  const paths = skepPaths(dir);
  await mkdir(paths.keysDir, { recursive: true });
  await writeFile(path.join(paths.keysDir, "daemon"), "private-half-not-a-real-key\n", {
    mode: 0o600,
  });
  await writeFile(
    paths.deviceToml,
    [
      'schema = "skep.device/v1"',
      'device = "mac"',
      `signing_key = "${path.join(paths.keysDir, "daemon")}"`,
      "",
      "[blackboard]",
      'url = "git@example.com:owner/blackboard.git"',
      "",
      "[[repos]]",
      'name = "app"',
      'url = "git@example.com:owner/app.git"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(paths.allowedSigners, `daemon:mac namespaces="git" ${PUB}\n`, { mode: 0o600 });
}

function execOk(name: string): ExecResult {
  return { code: 0, signal: null, stdout: `${name} 1.2.3\n`, stderr: "", timedOut: false };
}

/** Every probed binary is present at the pinned version. Nothing is actually executed. */
function presentExec(): DoctorDeps["exec"] {
  return async (file) => execOk(file);
}

function reachAll(): DoctorDeps["reach"] {
  return async (url) => ({ ok: true, detail: `reachable: ${url}` });
}

const frozen: Clock = {
  monotonicMs: () => 0,
  nowMs: () => Date.parse("2026-10-05T00:00:00Z"),
  sleep: () => Promise.resolve(),
};

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return { exec: presentExec(), reach: reachAll(), clock: frozen, minFreeBytes: 1, ...over };
}

function check(report: DoctorReport, name: string) {
  const found = report.checks.find((item) => item.name === name);
  expect(found, name).toBeDefined();
  return found ?? { name, status: "fail" as const, detail: "missing" };
}

describe("runDoctor pre-flight", () => {
  it("passes a device whose trust root names its daemon principal", async () => {
    const dir = await home();
    await writeDevice(dir);
    const report = await runDoctor(skepPaths(dir), deps());
    expect(check(report, "device_toml").status).toBe("ok");
    expect(check(report, "daemon_principal").status).toBe("ok");
    expect(check(report, "signing_key").status).toBe("ok");
    expect(check(report, "gitleaks").status).toBe("ok");
    expect(check(report, "blackboard_remote").status).toBe("ok");
    expect(check(report, "code_remote.app").status).toBe("ok");
    expect(check(report, "clock").status).toBe("ok");
    // No clone yet: the replay is skipped, which is a warning, not a failure.
    expect(check(report, "replay").status).toBe("warn");
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("fails when the daemon principal is absent from the trust root", async () => {
    const dir = await home();
    await writeDevice(dir);
    await writeFile(skepPaths(dir).allowedSigners, `daemon:vps namespaces="git" ${PUB}\n`);
    const report = await runDoctor(skepPaths(dir), deps());
    expect(check(report, "daemon_principal").status).toBe("fail");
    expect(check(report, "daemon_principal").detail).toContain("daemon:mac");
    expect(report.ok).toBe(false);
  });

  it("fails when the signing key is group-readable", async () => {
    const dir = await home();
    await writeDevice(dir);
    await chmod(path.join(skepPaths(dir).keysDir, "daemon"), 0o640);
    const report = await runDoctor(skepPaths(dir), deps());
    expect(check(report, "signing_key").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails when gitleaks is missing and never treats that as a skip", async () => {
    const dir = await home();
    await writeDevice(dir);
    const report = await runDoctor(
      skepPaths(dir),
      deps({
        exec: async (file) => {
          if (file === "gitleaks") {
            const error = new Error("spawn gitleaks ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return execOk(file);
        },
      }),
    );
    expect(check(report, "gitleaks").status).toBe("fail");
    expect(check(report, "gitleaks").detail).toMatch(/not on PATH/);
    expect(report.ok).toBe(false);
  });

  it("checks only outbound reachability of the blackboard and code remotes (D18)", async () => {
    const dir = await home();
    await writeDevice(dir);
    const probed: string[] = [];
    const report = await runDoctor(
      skepPaths(dir),
      deps({
        reach: async (url) => {
          probed.push(url);
          return url.includes("blackboard")
            ? { ok: false, detail: `unreachable: ${url}` }
            : { ok: true, detail: `reachable: ${url}` };
        },
      }),
    );
    expect(probed).toEqual([
      "git@example.com:owner/blackboard.git",
      "git@example.com:owner/app.git",
    ]);
    // No probe targets another device: every URL is a configured git remote.
    expect(probed.every((url) => url.startsWith("git@example.com:"))).toBe(true);
    expect(check(report, "blackboard_remote").status).toBe("fail");
    expect(check(report, "code_remote.app").status).toBe("ok");
    expect(report.ok).toBe(false);
  });

  it("reports the optional relay as a warning, never an error (D18)", async () => {
    const dir = await home();
    await writeDevice(dir);
    const down = await runDoctor(
      skepPaths(dir),
      deps({
        relayUrl: "wss://relay.example.invalid/v1/topic",
        reach: async (url) =>
          url.startsWith("wss:")
            ? { ok: false, detail: "no answer" }
            : { ok: true, detail: `reachable: ${url}` },
      }),
    );
    expect(check(down, "relay").status).toBe("warn");
    expect(check(down, "relay").detail).toMatch(/not required/);
    expect(down.ok).toBe(true);

    const up = await runDoctor(
      skepPaths(dir),
      deps({ relayUrl: "wss://relay.example.invalid/v1/topic" }),
    );
    expect(check(up, "relay").status).toBe("warn");
    expect(up.ok).toBe(true);

    const absent = await runDoctor(skepPaths(dir), deps());
    expect(absent.checks.some((item) => item.name === "relay")).toBe(false);
  });

  it("checks the pinned CLI version and nothing about its provider (D19)", async () => {
    const dir = await home();
    await writeDevice(dir);
    const roles = path.join(dir, "roles");
    await mkdir(path.join(roles, "coding"), { recursive: true });
    await writeFile(
      path.join(roles, "coding", "AGENT.md"),
      [
        "---",
        "schema: skep.agent/v1",
        "role: coding",
        "agent_cli: codex",
        'cli_version: "1.2.3"',
        "repos:",
        "  - git@example.com:owner/app.git",
        "capabilities: [typescript]",
        "---",
        "Implement code.",
        "",
      ].join("\n"),
    );
    const invocations: string[][] = [];
    const report = await runDoctor(
      skepPaths(dir),
      deps({
        rolesDir: roles,
        exec: async (file, args) => {
          invocations.push([file, ...args]);
          return file === "codex"
            ? { code: 0, signal: null, stdout: "codex 9.9.9\n", stderr: "", timedOut: false }
            : execOk(file);
        },
      }),
    );
    expect(check(report, "agent_md.coding").status).toBe("ok");
    expect(check(report, "agent_cli.coding").status).toBe("fail");
    expect(check(report, "agent_cli.coding").detail).toContain("9.9.9");
    expect(check(report, "repo_allowlist.coding").status).toBe("ok");
    // The probe is `--version` only. No config directory, provider name or credential is read.
    expect(invocations.filter((call) => call[0] === "codex")).toEqual([["codex", "--version"]]);
    expect(JSON.stringify(report)).not.toMatch(/provider|api.key|OPENAI|sk-/i);
    expect(report.ok).toBe(false);
  });

  it("fails when the agent user can write AGENT.md", async () => {
    const dir = await home();
    await writeDevice(dir);
    const roles = path.join(dir, "roles");
    await mkdir(path.join(roles, "coding"), { recursive: true });
    await writeFile(path.join(roles, "coding", "AGENT.md"), agentMd("1.2.3"));
    const previous = process.env.SKEP_AGENT_USER;
    process.env.SKEP_AGENT_USER = "agent";
    try {
      const report = await runDoctor(
        skepPaths(dir),
        deps({
          rolesDir: roles,
          exec: async (file, args) => {
            // `sudo -n -u agent test -w <file>` succeeding means the agent user can rewrite policy.
            if (file === "sudo" && args.includes("-w")) return execOk("sudo");
            return execOk(file);
          },
        }),
      );
      expect(check(report, "agent_user.coding").status).toBe("fail");
      expect(report.ok).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SKEP_AGENT_USER;
      else process.env.SKEP_AGENT_USER = previous;
    }
  });

  it("fails when a role's checks file does not parse", async () => {
    const dir = await home();
    await writeDevice(dir);
    const roles = path.join(dir, "roles");
    await mkdir(path.join(roles, "coding", ".skep"), { recursive: true });
    await writeFile(path.join(roles, "coding", "AGENT.md"), agentMd("1.2.3"));
    await writeFile(
      path.join(roles, "coding", ".skep", "checks.toml"),
      'schema = "skep.checks/v1"\n\n[checks.unit]\nargv = "npm test"\n',
    );
    const report = await runDoctor(skepPaths(dir), deps({ rolesDir: roles }));
    expect(check(report, "checks_file.coding").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails when an AGENT.md repo is outside the device allowlist", async () => {
    const dir = await home();
    await writeDevice(dir);
    const roles = path.join(dir, "roles");
    await mkdir(path.join(roles, "coding"), { recursive: true });
    await writeFile(
      path.join(roles, "coding", "AGENT.md"),
      agentMd("1.2.3", "git@example.com:owner/not-allowed.git"),
    );
    const report = await runDoctor(skepPaths(dir), deps({ rolesDir: roles }));
    expect(check(report, "repo_allowlist.coding").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("warns about clock skew and never fails on it (PRD §13.3 step 8)", async () => {
    const dir = await home();
    await writeDevice(dir);
    const skewed: Clock = { ...frozen, nowMs: () => frozen.nowMs() + 60 * 60_000 };
    const report = await runDoctor(
      skepPaths(dir),
      deps({ clock: skewed, referenceMs: frozen.nowMs() }),
    );
    expect(check(report, "clock").status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("fails when free disk is below the threshold", async () => {
    const dir = await home();
    await writeDevice(dir);
    const report = await runDoctor(skepPaths(dir), deps({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    expect(check(report, "disk").status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("runDoctor replay", () => {
  it("replays a human-signed genesis and reports no invariant violations", async () => {
    const dir = await home();
    await writeDevice(dir);
    const paths = skepPaths(dir);
    const sha = await genesisClone(dir, paths);
    const report = await runDoctor(paths, deps());
    expect(check(report, "replay").status).toBe("ok");
    expect(report.replay).toEqual({ tip: sha, seq: 0, invalid: 0 });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails the replay when the trust root cannot verify the genesis", async () => {
    const dir = await home();
    await writeDevice(dir);
    const paths = skepPaths(dir);
    await genesisClone(dir, paths);
    // Replace the trust root with a key that signed nothing. The commits stay byte-identical, so
    // the failure comes from verification: an untrusted genesis cannot build a state (PRD §10.1).
    await writeFile(paths.allowedSigners, `daemon:mac namespaces="git" ${PUB}\n`);
    const report = await runDoctor(paths, deps());
    expect(check(report, "replay").status).toBe("fail");
    expect(report.replay).toBeUndefined();
    expect(report.ok).toBe(false);
  });
});

describe("skep doctor command", () => {
  it("prints the human report and exits 1 when a check fails", async () => {
    const dir = await home();
    await writeDevice(dir);
    await writeFile(skepPaths(dir).allowedSigners, "# empty on purpose\n");
    const out = capture(dir);
    const code = await runDoctorCli(out, ["doctor"], deps());
    expect(code).toBe(1);
    expect(out.stdout).toContain("fail daemon_principal");
    expect(out.stdout).toContain("doctor: failed");
  });

  it("emits exactly one JSON document with --machine", async () => {
    const dir = await home();
    await writeDevice(dir);
    const out = capture(dir);
    const code = await runDoctorCli(out, ["--machine", "doctor"], deps());
    expect(code).toBe(0);
    const lines = out.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0] ?? "") as { ok: boolean; result: DoctorReport };
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.checks.some((item) => item.name === "blackboard_remote")).toBe(true);
    expect(out.stderr).toBe("");
  });

  it("parses through runCli, which resolves --home before the action", async () => {
    const dir = await home();
    const out = capture("/nowhere");
    const code = await runCli(["--home", dir, "doctor", "--help"], out.ctx);
    expect(code).toBe(0);
    expect(out.stdout).toContain("--roles-dir");
  });
});

/**
 * Drive the real `register` action with injected probes. `runCli` builds its own program, whose
 * action would shell out to the host's binaries and network, so the command is registered here
 * with the test doubles and parsed directly.
 */
async function runDoctorCli(
  out: { stdout: string; stderr: string; ctx: CliContext },
  argv: string[],
  injected: DoctorDeps,
): Promise<number> {
  const machine = argv.includes("--machine");
  const homeFlag = argv.indexOf("--home");
  out.ctx.paths = skepPaths(
    homeFlag === -1 ? (out.ctx.env.SKEP_HOME ?? "") : (argv[homeFlag + 1] ?? ""),
  );
  out.ctx.output = () => createOutput({ machine, stdout: out.ctx.stdout, stderr: out.ctx.stderr });
  out.ctx.exitCode = undefined;
  const program = new Command();
  program.exitOverride().option("--machine").option("--home <dir>");
  register(program, out.ctx, injected);
  await program.parseAsync(argv, { from: "user" });
  return out.ctx.exitCode ?? EXIT.ok;
}

function agentMd(version: string, repo = "git@example.com:owner/app.git"): string {
  return [
    "---",
    "schema: skep.agent/v1",
    "role: coding",
    "agent_cli: pi",
    `cli_version: "${version}"`,
    "repos:",
    `  - ${repo}`,
    "capabilities: [typescript]",
    "---",
    "Implement code.",
    "",
  ].join("\n");
}

function capture(dir: string, pathEnv = ""): { stdout: string; stderr: string; ctx: CliContext } {
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
    env: { SKEP_HOME: dir, PATH: pathEnv },
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

/** A real one-commit blackboard clone signed by a throwaway human key (ARCHITECTURE §7.1). */
async function genesisClone(dir: string, paths: ReturnType<typeof skepPaths>): Promise<string> {
  const git = new NodeGitRunner();
  const remote = path.join(dir, "remote.git");
  await initRepo(remote, { bare: true });
  const human = await generateKey(dir, "human");
  const daemon = await generateKey(dir, "daemonkey");
  await writeAllowedSigners(paths.allowedSigners, [
    { principal: "human", pubLine: human.pubLine },
    { principal: "daemon:mac", pubLine: daemon.pubLine },
  ]);
  const clone = new BlackboardClone({ git, dir: paths.blackboardClone, remoteUrl: remote });
  return createGenesis({
    git,
    clone,
    signer: new SshKeySigner({ principal: "human", keyPath: human.privPath }),
    genesis: genesisDoc(),
    allowedSignersText: `daemon:mac namespaces="git" ${daemon.pubLine}\n`,
    ident: {
      name: "human",
      email: "human@example.invalid",
      timestampSec: 1_791_244_800,
      tz: "+0000",
    },
  });
}
