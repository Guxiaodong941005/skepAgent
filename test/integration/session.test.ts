/**
 * Real master and sub on 127.0.0.1. No git remote, no code host, no agent CLI.
 * The sub reports a local result with a structured `none`/`local` submit outcome; nothing is
 * pushed.
 */

import { describe, expect, it, vi } from "vitest";
import { connectSub, startMaster } from "../../src/session/index.js";

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
