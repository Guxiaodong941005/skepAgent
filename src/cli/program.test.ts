import { describe, expect, it } from "vitest";
import { skepPaths } from "../config/paths.js";
import type { CliContext } from "./context.js";
import { runCli } from "./program.js";

const TASK = "T-20261005-7f3a";
const AGENT = "mac.coding";

interface Captured {
  stdout: string;
  stderr: string;
  ctx: CliContext;
}

/** Streams captured in memory. Nothing here touches `~/.skep` or a real tty. */
function capture(env: NodeJS.ProcessEnv = { SKEP_HOME: "/tmp/skep-cli-test" }): Captured {
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
    env: { ...env },
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

function jsonLine(stdout: string): { ok: boolean; error?: { code: string; message: string } } {
  const lines = stdout.split("\n").filter((l) => l !== "");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as { ok: boolean; error?: { code: string; message: string } };
}

describe("runCli help", () => {
  it("exits 0 and lists every MVP command", async () => {
    const cap = capture();
    const code = await runCli(["--help"], cap.ctx);
    expect(code).toBe(0);
    const help = cap.stdout;
    const expected = [
      "init",
      "agent",
      "task",
      "plan",
      "replan",
      "lease",
      "decide",
      "status",
      "log",
      "logs",
      "doctor",
      "sim",
    ];
    for (const name of expected) {
      expect(help).toContain(name);
    }
    expect(cap.stderr).toBe("");
  });

  it("lists the subcommands of each group", async () => {
    const groups: Array<[string[], string[]]> = [
      [
        ["agent", "--help"],
        ["start", "stop"],
      ],
      [
        ["task", "--help"],
        ["new", "cancel"],
      ],
      [
        ["plan", "--help"],
        ["show", "approve", "reject"],
      ],
      [["lease", "--help"], ["revoke"]],
      [["sim", "--help"], ["run"]],
    ];
    for (const [argv, subs] of groups) {
      const cap = capture();
      const code = await runCli(argv, cap.ctx);
      expect(code).toBe(0);
      for (const sub of subs) expect(cap.stdout).toContain(sub);
    }
  });
});

describe("argument validation", () => {
  const cases: Array<[string, string[]]> = [
    ["task id", ["task", "cancel", "not-a-task", "--reason", "duplicate"]],
    ["item id", ["lease", "revoke", TASK, "item-9", "--epoch", "1"]],
    ["agent id", ["logs", "not an agent"]],
    ["epoch", ["lease", "revoke", TASK, "W1", "--epoch", "0"]],
    ["epoch negative", ["lease", "revoke", TASK, "W1", "--epoch", "-3"]],
    ["plan version", ["plan", "show", TASK, "--version", "0"]],
    ["owner", ["task", "new", "Fix the build", "--repo", "app", "--owner", "HUMAN"]],
    ["device", ["init", "--device", "Mac", "--blackboard", "git@github.com:o/bb.git"]],
  ];

  for (const [label, argv] of cases) {
    it(`rejects a bad ${label} with exit 2, naming the argument`, async () => {
      const cap = capture();
      const code = await runCli(argv, cap.ctx);
      expect(code).toBe(2);
      expect(cap.stderr.toLowerCase()).toContain("invalid");
      expect(cap.stdout).toBe("");
    });

    it(`rejects a bad ${label} as one JSON line in --machine mode`, async () => {
      const cap = capture();
      const code = await runCli(["--machine", ...argv], cap.ctx);
      expect(code).toBe(2);
      expect(cap.stderr).toBe("");
      const body = jsonLine(cap.stdout);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("usage");
      expect(body.error?.message.toLowerCase()).toContain("invalid");
    });
  }
});

describe("decide", () => {
  it("rejects zero resolution flags", async () => {
    const cap = capture();
    const code = await runCli(["decide", TASK], cap.ctx);
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/exactly one/);
  });

  it("rejects two resolution flags", async () => {
    const cap = capture();
    const code = await runCli(["decide", TASK, "--resume", "--cancel"], cap.ctx);
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/exactly one/);
  });

  it("rejects --owner together with --replan", async () => {
    const cap = capture();
    const code = await runCli(["decide", TASK, "--replan", "--owner", AGENT], cap.ctx);
    expect(code).toBe(2);
  });

  it("reports the usage error as JSON with --machine", async () => {
    const cap = capture();
    const code = await runCli(["--machine", "decide", TASK, "--resume", "--replan"], cap.ctx);
    expect(code).toBe(2);
    const body = jsonLine(cap.stdout);
    expect(body.error?.code).toBe("usage");
    expect(body.error?.message).toMatch(/exactly one/);
  });
});

describe("task new language guard", () => {
  const chinese = "修复登录跳转，会话过期时返回首页";

  it("rejects predominantly Chinese text with non_english_task", async () => {
    const cap = capture();
    const code = await runCli(["task", "new", chinese, "--repo", "app"], cap.ctx);
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/non-Latin/);
  });

  it("emits code non_english_task in --machine mode", async () => {
    const cap = capture();
    const code = await runCli(["--machine", "task", "new", chinese, "--repo", "app"], cap.ctx);
    expect(code).toBe(2);
    const body = jsonLine(cap.stdout);
    expect(body.error?.code).toBe("non_english_task");
  });

  it("allows the same text with --allow-non-english, then stubs", async () => {
    const cap = capture();
    const code = await runCli(
      ["task", "new", chinese, "--repo", "app", "--allow-non-english"],
      cap.ctx,
    );
    expect(code).toBe(4);
    expect(cap.stderr).toMatch(/not implemented/);
  });
});

describe("stubs", () => {
  const invocations: string[][] = [
    ["init", "--device", "mac", "--blackboard", "git@github.com:o/bb.git"],
    ["agent", "start"],
    ["agent", "stop", "--role-dir", "/tmp/role"],
    ["task", "new", "Fix the login redirect", "--repo", "app"],
    ["task", "new", "Fix it", "--repo", "app", "--owner", AGENT, "--team"],
    ["task", "cancel", TASK, "--reason", "no longer needed"],
    ["plan", "show", TASK],
    ["plan", "show", TASK, "--version", "2", "--diff"],
    ["plan", "approve", TASK, "--note", "looks right"],
    ["plan", "reject", TASK],
    ["replan", TASK, "--reason", "the approach fails", "--evidence", "a.log", "b.log"],
    ["lease", "revoke", TASK, "W2", "--epoch", "3", "--reason", "holder went stale"],
    ["decide", TASK, "--resume"],
    ["decide", TASK, "--replan", "--note", "try again"],
    ["decide", TASK, "--cancel"],
    ["decide", TASK, "--owner", "vps.coding"],
    ["logs", AGENT],
    ["logs", AGENT, "--follow"],
    ["doctor"],
  ];

  for (const argv of invocations) {
    it(`${argv.join(" ")} exits 4 not_implemented`, async () => {
      const cap = capture();
      const code = await runCli(argv, cap.ctx);
      expect(code).toBe(4);
      expect(cap.stderr).toMatch(/not implemented/);
      expect(cap.stdout).toBe("");
    });

    it(`${argv.join(" ")} --machine prints one JSON error line`, async () => {
      const cap = capture();
      const code = await runCli(["--machine", ...argv], cap.ctx);
      expect(code).toBe(4);
      expect(cap.stderr).toBe("");
      const body = jsonLine(cap.stdout);
      expect(body).toEqual({
        ok: false,
        error: { code: "not_implemented", message: body.error?.message },
      });
      expect(body.error?.message).toMatch(/not implemented/);
    });
  }
});

describe("--home", () => {
  it("overrides SKEP_HOME and the default for the resolved paths", async () => {
    const cap = capture({ SKEP_HOME: "/tmp/from-env" });
    // `doctor` stays a stub, so the exit code is the skeleton's; `status` now reads a blackboard.
    const code = await runCli(["--home", "rel/home", "doctor"], cap.ctx);
    expect(code).toBe(4);
    expect(cap.ctx.env.SKEP_HOME).toBe("rel/home");
    expect(cap.ctx.paths).toEqual(skepPaths("rel/home"));
    expect(cap.ctx.paths?.home.startsWith("/")).toBe(true);
  });

  it("keeps SKEP_HOME when --home is absent", async () => {
    const cap = capture({ SKEP_HOME: "/tmp/from-env" });
    await runCli(["doctor"], cap.ctx);
    expect(cap.ctx.paths?.home).toBe("/tmp/from-env");
    expect(cap.ctx.paths?.deviceToml).toBe("/tmp/from-env/device.toml");
  });
});
