/**
 * Real master and sub on 127.0.0.1. No git remote, no code host, no agent CLI.
 * The sub reports a local result with a structured `none`/`local` submit outcome; nothing is
 * pushed.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentRuntime,
  type AgentSessionBackend,
  type ItemWorker,
  workItem,
} from "../../src/cli/commands/session.js";
import { connectSub, startMaster } from "../../src/session/index.js";

const execFileP = promisify(execFile);
const ESC = "\u001b";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("session mode on loopback", () => {
  it("joins, routes a datalist to the matching repo, and records a local result", async () => {
    const master = await startMaster({
      listen: { host: "127.0.0.1", port: 0 },
      device: "main",
      repo: "app",
      controlToken: "0123456789abcdef0123456789abcdef",
      acceptJoin: async () => true,
      onJoinCode: () => {},
    });
    const code = master.status().joinCode;
    if (!code || !master.address) throw new Error("master did not publish a join code");

    const sub = await connectSub({
      target: master.address,
      code,
      device: "service",
      describe: async () => ({ repo: "app", head: SHA_A, role: "coding" }),
      collectDatalist: async () => [{ kind: "path", path: "src/login.ts" }],
      onItem: async () => ({
        repo: "app",
        baseSha: SHA_A,
        headSha: SHA_B,
        checks: [{ name: "unit", status: "pass" }],
        summary: "local commit only",
        submit: { method: "none", state: "local", branch: "skep/session/I-1-e1" },
      }),
    });

    const { intentId } = await master.submitIntent("add a login event");
    await vi.waitFor(() => {
      const item = master.status().intents[0]?.items[0];
      expect(item?.state).toBe("done");
    });
    const status = master.status();
    expect(status.intents[0]?.intentId).toBe(intentId);
    expect(status.intents[0]?.items[0]).toMatchObject({
      repo: "app",
      assignee: sub.peerId,
      state: "done",
      result: {
        headSha: SHA_B,
        summary: "local commit only",
        submit: { method: "none", state: "local", branch: "skep/session/I-1-e1" },
      },
    });

    await sub.close();
    await master.close();
  });
});

describe("session mode with a live agent view (SK-621)", () => {
  it("a blocked herdr agent reaches the master as pending, redacted and control-free", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skep-session-live-"));
    try {
      const repo = path.join(root, "app");
      await mkdir(repo);
      const gitPath = (await execFileP("sh", ["-c", "command -v git"])).stdout.trim();
      const env = { PATH: path.dirname(gitPath), HOME: root };
      const gitIn = (args: string[]) => execFileP("git", args, { cwd: repo, env });
      await gitIn(["init", "--quiet", "-b", "main"]);
      await writeFile(path.join(repo, "README.md"), "app\n");
      await gitIn(["add", "README.md"]);
      await gitIn([
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "i",
      ]);
      const base = (await gitIn(["rev-parse", "HEAD"])).stdout.trim();

      const planted = `ghp_${"Z9y8X7w6V5".repeat(4)}`;
      const calls: string[] = [];
      const backend: AgentSessionBackend = {
        name: "herdr",
        probe: async () => ({ protocol: 22, schemaVersion: 1 }),
        start: async (opts) => {
          calls.push("start");
          return {
            name: opts.name,
            paneId: "pane-1",
            focusCommand: ["herdr", "agent", "focus", opts.name],
          };
        },
        prompt: async () => {
          calls.push("prompt");
        },
        wait: async () => "blocked",
        read: async () => `\u001b[33mApprove running a command?\u001b[0m\r\nkey ${planted}\n`,
        focus: async () => {
          calls.push("focus");
        },
        close: async () => {
          calls.push("close");
        },
      };
      const runtime: AgentRuntime = {
        ptyRunner: () => {
          throw new Error("pty must not run");
        },
        herdrBackend: () => backend,
        stripTerminalControls: (text) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m|\r`, "g"), ""),
        isPtyUnavailable: () => false,
      };
      const stderr: string[] = [];
      const worker: ItemWorker = {
        ctx: {
          stdout: { write: () => {} },
          stderr: { write: (s) => stderr.push(s) },
          env,
          cwd: repo,
          output: () => {
            throw new Error("unused");
          },
        },
        root: path.join(root, "work"),
        method: "push",
        ask: async () => null,
        agent: {
          view: "herdr",
          cli: "codex",
          runtime: async () => runtime,
          journal: path.join(root, "journal"),
          notify: async () => {},
        },
      };

      const master = await startMaster({
        listen: { host: "127.0.0.1", port: 0 },
        device: "main",
        repo: "app",
        controlToken: "0123456789abcdef0123456789abcdef",
        acceptJoin: async () => true,
        onJoinCode: () => {},
      });
      const code = master.status().joinCode;
      if (!code || !master.address) throw new Error("master did not publish a join code");
      const sub = await connectSub({
        target: master.address,
        code,
        device: "service",
        describe: async () => ({ repo: "app", head: base, role: "coding" }),
        collectDatalist: async () => [{ kind: "path", path: "README.md" }],
        onItem: (item) => workItem(worker, item),
      });
      await master.submitIntent("add a login event");
      await vi.waitFor(() => expect(master.status().intents[0]?.items[0]?.state).toBe("done"), {
        timeout: 10_000,
      });
      const result = master.status().intents[0]?.items[0]?.result;
      expect(result).toMatchObject({
        baseSha: base,
        headSha: base,
        submit: { method: "push", state: "pending", branch: "skep/session/I-1-e1" },
      });
      expect(result?.summary).toContain("Approve running a command?");
      expect(result?.summary).not.toContain(planted);
      expect(result?.summary).not.toContain("\u001b");
      expect(calls).toEqual(["start", "prompt"]);
      expect(stderr.join("")).toContain(
        "agent skep-i-1-e1 is waiting for you: herdr agent focus skep-i-1-e1",
      );
      await sub.close();
      await master.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
