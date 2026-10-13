// Master agent → peers → master agent over a real master and two real subs on 127.0.0.1:0
// (docs/plans/tui-scroll-and-herdr-controller.md §7 Phase 2, exit criteria 1, 2 and 8).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationItem } from "../../src/core/orchestration/reducer.js";
import type { MasterAgent } from "../../src/orchestrator/master-agent.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import {
  connectSub,
  type ItemContext,
  type MasterHandle,
  type PlanItem,
  type SubHandle,
  type SubResult,
  startMaster,
} from "../../src/session/index.js";
import { itemVerdict } from "../../src/session/master.js";
import type { Clock } from "../../src/util/clock.js";

const clock: Clock = {
  monotonicMs: () => 0,
  nowMs: () => 1_800_000_000_000,
  sleep: () => new Promise(() => {}),
};

const masters: MasterHandle[] = [];
const subs: SubHandle[] = [];
afterEach(async () => {
  await Promise.all(subs.splice(0).map((sub) => sub.close()));
  await Promise.all(masters.splice(0).map((master) => master.close()));
});

function result(item: PlanItem, summary: string): SubResult {
  return {
    repo: item.repo,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checks: [{ name: "agent", status: "pass" }],
    summary,
  };
}

async function join(
  m: MasterHandle,
  device: string,
  repo: string,
  onItem: (item: PlanItem, context?: ItemContext) => Promise<SubResult | null>,
): Promise<SubHandle> {
  const code = m.status().joinCode;
  if (code === null || m.address === null) throw new Error("master has no join code");
  const handle = await connectSub({
    target: { host: "127.0.0.1", port: m.address.port },
    code,
    device,
    describe: async () => ({ repo, head: "c".repeat(40), role: "coding" }),
    collectDatalist: async () => [],
    onItem,
  });
  subs.push(handle);
  await vi.waitFor(() =>
    expect(m.status().peers.some((peer) => peer.peerId === handle.peerId)).toBe(true),
  );
  return handle;
}

describe("orchestration over a real session", () => {
  it("brief reaches a new peer in full and an old peer by title; synthesis sees both results", async () => {
    const m = await startMaster({
      listen: { host: "127.0.0.1", port: 0 },
      device: "laptop",
      repo: "app",
      controlToken: "a".repeat(32),
      acceptJoin: async () => true,
      onJoinCode: () => {},
      datalistTimeoutMs: 5_000,
    });
    masters.push(m);

    const brief = `Add a /healthz endpoint. ${"Keep it dependency free and add a test. ".repeat(10)}`;
    expect(brief.length).toBeGreaterThan(200);
    const received: Record<string, string> = {};
    // A current peer works from the intent's full text (S8).
    await join(m, "mac", "app", async (item, context) => {
      received.mac = context?.intentText ?? item.title;
      return result(item, "done · claude · 5s\nadded src/health.ts and a test");
    });
    // A ≤0.1.13 peer knows nothing of the context and prompts its agent with the title.
    await join(m, "vps", "api", async (item) => {
      received.vps = item.title;
      return result(item, "done · codex · 7s\nadded GET /healthz to the api");
    });

    const prompts: string[] = [];
    const conversations: string[] = [];
    const replies = [
      `\`\`\`json\n${JSON.stringify({ title: "Add /healthz to app and api", brief })}\n\`\`\``,
      "Both services now expose /healthz.",
    ];
    const agent: MasterAgent = {
      cli: "codex",
      conversationId: null,
      contextChars: 0,
      turn: async ({ prompt }) => {
        prompts.push(prompt);
        conversations.push("thread-1");
        return { text: replies.shift() ?? "", conversationId: "thread-1" };
      },
      reset: () => {},
    };
    const shown: string[] = [];
    const orchestrator = new Orchestrator({
      agent,
      clock,
      ledger: null,
      peers: () =>
        m.status().peers.map((peer) => ({
          peerId: peer.peerId,
          device: peer.device,
          role: peer.role ?? "coding",
          ...(peer.repo === null ? {} : { repo: peer.repo }),
        })),
      dispatch: async (text) => (await m.submitIntent(text, ["app", "api"])).intentId,
      items: (intentIds) => {
        const status = m.status();
        const devices = new Map(status.peers.map((peer) => [peer.peerId, peer.device]));
        const out: OrchestrationItem[] = [];
        for (const intent of status.intents.filter((i) => intentIds.includes(i.intentId))) {
          for (const item of intent.items) {
            out.push({
              intentId: intent.intentId,
              itemId: item.itemId,
              verdict: itemVerdict(item),
              repo: item.repo,
              device: devices.get(item.assignee) ?? "?",
              ...(item.result === undefined ? {} : { summary: item.result.summary }),
            });
          }
        }
        return out;
      },
      guard: async () => async () => [],
      ask: async () => null,
      confirm: async () => ({ action: "send" }),
      show: (text) => shown.push(text),
    });

    const { done } = orchestrator.start("add health checks to both services", "auto");
    await vi.waitFor(() => expect(Object.keys(received)).toHaveLength(2));
    await vi.waitFor(() => {
      orchestrator.poll();
      expect(orchestrator.active()).toEqual([]);
    });
    const state = await done;

    const sent = `Add /healthz to app and api\n\n${brief.trim()}`;
    expect(received.mac).toBe(sent);
    expect(received.vps).toBe(sent.slice(0, 200));
    expect(received.vps?.startsWith("Add /healthz to app and api")).toBe(true);
    expect(state.phase).toBe("done");
    expect(state.synthesis).toBe("Both services now expose /healthz.");
    const synthesis = prompts[1] ?? "";
    expect(synthesis).toContain("add health checks to both services");
    expect(synthesis).toContain("added src/health.ts and a test");
    expect(synthesis).toContain("added GET /healthz to the api");
    expect(conversations).toEqual(["thread-1", "thread-1"]);
    expect(shown.join("\n")).toContain("Both services now expose /healthz.");
  });
});
