import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../util/exec.js";
import { agentEnv, resolveAgentUser, SandboxEnvError } from "./sandbox-env.js";

const home = resolve(".skep-sim/agent-home");

describe("allowlisted agent environment", () => {
  it("forwards only runtime variables and replaces the daemon's user identity", () => {
    const source = {
      PATH: "bin",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "C.UTF-8",
      TERM: "dumb",
      TMPDIR: join(home, "tmp"),
      HOME: resolve(".skep-sim/daemon-home"),
      USER: "daemon",
      LOGNAME: "daemon",
      CODEX_HOME: resolve(".skep-sim/daemon-config"),
      CLAUDE_CONFIG_DIR: resolve(".skep-sim/daemon-config"),
      PI_CODING_AGENT_DIR: resolve(".skep-sim/daemon-config"),
      GIT_ASKPASS: "blocked",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "blocked",
      GIT_SSH_COMMAND: "blocked",
      GIT_DIR: "blocked",
      SSH_ASKPASS: "blocked",
      SSH_AUTH_SOCK: "blocked",
      GH_TOKEN: "blocked",
      GITHUB_TOKEN: "blocked",
      GCM_CREDENTIAL_STORE: "blocked",
      AWS_ACCESS_KEY_ID: "blocked",
      OPENAI_API_KEY: "blocked",
      OPENAI_BASE_URL: "blocked",
      ANTHROPIC_API_KEY: "blocked",
      MODEL: "blocked",
      SKEP_HOME: "blocked",
      UNLISTED_VARIABLE: "blocked",
      EMPTY_VARIABLE: undefined,
    };
    expect(agentEnv({ source, home, user: "skep-agent" })).toEqual({
      PATH: source.PATH,
      LANG: source.LANG,
      LC_ALL: source.LC_ALL,
      LC_CTYPE: source.LC_CTYPE,
      TERM: source.TERM,
      TMPDIR: source.TMPDIR,
      HOME: home,
      USER: "skep-agent",
      LOGNAME: "skep-agent",
    });
    expect(source.USER).toBe("daemon");
  });

  it("does not read the ambient process environment when no source is supplied", () => {
    vi.stubEnv("GIT_ASKPASS", "blocked");
    vi.stubEnv("SSH_AUTH_SOCK", "blocked");
    vi.stubEnv("CODEX_HOME", "blocked");
    try {
      expect(agentEnv({ home, user: "agent" })).toEqual({
        HOME: home,
        USER: "agent",
        LOGNAME: "agent",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["codex", "CODEX_HOME"],
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["pi", "PI_CODING_AGENT_DIR"],
  ] as const)("sets only the explicitly configured %s directory", (agentCli, name) => {
    const configDir = join(home, "config");
    const tmpDir = join(home, "agent-tmp");
    expect(
      agentEnv({
        source: { TMPDIR: join(home, "daemon-tmp"), OPENAI_API_KEY: "blocked" },
        home,
        user: "agent",
        tmpDir,
        agentCli,
        configDir,
      }),
    ).toEqual({ HOME: home, USER: "agent", LOGNAME: "agent", TMPDIR: tmpDir, [name]: configDir });
  });

  it("rejects invalid directories, user names, NUL runtime values and unknown options", () => {
    expect(() => agentEnv({ home: "relative", user: "agent" })).toThrow(SandboxEnvError);
    expect(() => agentEnv({ home, user: "--user" })).toThrow(SandboxEnvError);
    expect(() => agentEnv({ home, user: "agent", configDir: home })).toThrow(/agent CLI/);
    expect(() => agentEnv({ home, user: "agent", tmpDir: "relative" })).toThrow(SandboxEnvError);
    expect(() => agentEnv({ home, user: "agent", source: { PATH: "bin\0" } })).toThrow(
      SandboxEnvError,
    );
    expect(() => agentEnv({ home, user: "agent", ...{ extra: "blocked" } })).toThrow(
      SandboxEnvError,
    );
  });

  it("omits undefined runtime variables and ignores even malformed unlisted values", () => {
    expect(
      agentEnv({ home, user: "agent", source: { PATH: undefined, GIT_ASKPASS: "blocked\0" } }),
    ).toEqual({ HOME: home, USER: "agent", LOGNAME: "agent" });
  });
});

function result(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0, signal: null, timedOut: false };
}

describe("optional agent user resolution", () => {
  it("leaves uid/gid unset when no agent user is configured", async () => {
    const exec = vi.fn();
    expect(await resolveAgentUser(undefined, { exec })).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves the user and primary group with literal argv and an empty credential environment", async () => {
    const exec = vi.fn(async (_file: string, args: string[]) =>
      result(args[0] === "-u" ? "1001\n" : "1002\n"),
    );
    expect(await resolveAgentUser("skep-agent", { exec })).toEqual({ uid: 1001, gid: 1002 });
    expect(exec.mock.calls).toEqual([
      ["/usr/bin/id", ["-u", "skep-agent"], { env: { LC_ALL: "C" } }],
      ["/usr/bin/id", ["-g", "skep-agent"], { env: { LC_ALL: "C" } }],
    ]);
  });

  it("permits uid/gid zero, without substituting the daemon's identity", async () => {
    expect(await resolveAgentUser("agent", { exec: vi.fn(async () => result("0\n")) })).toEqual({
      uid: 0,
      gid: 0,
    });
  });

  it.each(["", "-1", "1\n2", "NaN", "4294967295", "9007199254740993"])(
    "rejects invalid OS identity output %j",
    async (stdout) => {
      await expect(
        resolveAgentUser("agent", { exec: vi.fn(async () => result(stdout)) }),
      ).rejects.toThrow(SandboxEnvError);
    },
  );

  it("rejects malformed user names before executing anything", async () => {
    const exec = vi.fn();
    await expect(resolveAgentUser("--agent", { exec })).rejects.toThrow(SandboxEnvError);
    await expect(resolveAgentUser("agent\n", { exec })).rejects.toThrow(SandboxEnvError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a missing user and preserves the actionable executor error", async () => {
    const cause = new Error("Local user does not exist");
    const exec = vi.fn(async () => {
      throw cause;
    });
    await expect(resolveAgentUser("agent", { exec })).rejects.toMatchObject({
      name: "SandboxEnvError",
      message: expect.stringContaining("configure an existing local user"),
      cause,
    });
  });

  it("rejects unsuccessful lookup results from injected executors", async () => {
    const exec = vi.fn(async () => ({ ...result("1001"), code: 1 }));
    await expect(resolveAgentUser("agent", { exec })).rejects.toThrow(SandboxEnvError);
  });
});
