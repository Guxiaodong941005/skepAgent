// D36: real loopback session frames, fake read-only master and role agents.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationItem } from "../../src/core/orchestration/reducer.js";
import { bind } from "../../src/core/skills/compose.js";
import type { MasterAgent } from "../../src/orchestrator/master-agent.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import {
  connectSub,
  type MasterHandle,
  type SubHandle,
  startMaster,
} from "../../src/session/index.js";
import { itemVerdict } from "../../src/session/master.js";
import { loadSkillSource } from "../../src/skills/loader.js";
import { iotBleFeature } from "../../src/skills/packaged/iot-ble-feature.js";

const subs: SubHandle[] = [];
const masters: MasterHandle[] = [];
afterEach(async () => {
  await Promise.all(subs.splice(0).map((s) => s.close()));
  await Promise.all(masters.splice(0).map((m) => m.close()));
});
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("IoT skill staged workflow over loopback", () => {
  it.each(["normal", "shared", "retry", "skip", "leave-done"])(
    "drafts one contract and respects stages: %s",
    async (mode) => {
      const shared = mode === "shared";
      const master = await startMaster({
        listen: { host: "127.0.0.1", port: 0 },
        device: "hub",
        repo: "hub-repo",
        controlToken: "a".repeat(32),
        acceptJoin: async () => true,
        onJoinCode: () => {},
        datalistTimeoutMs: 2_000,
      });
      masters.push(master);
      const received: Record<string, string> = {};
      const deliveries: Record<string, number> = {};
      const joined = new Map<string, SubHandle>();
      const deviceGate = gate();
      const serverGate = gate();
      const joinRole = async (role: string) => {
        const code = master.status().joinCode;
        if (!code || !master.address) throw new Error("master is not listening");
        const sub = await connectSub({
          target: { host: "127.0.0.1", port: master.address.port },
          code,
          device: `test-${role}`,
          role,
          repo: shared && ["ios", "android"].includes(role) ? "mobile-repo" : `${role}-repo`,
          describe: async () => ({
            repo: shared && ["ios", "android"].includes(role) ? "mobile-repo" : `${role}-repo`,
            role,
            head: "c".repeat(40),
          }),
          collectDatalist: async () => [],
          onItem: async (item, context) => {
            deliveries[role] = (deliveries[role] ?? 0) + 1;
            received[role] = context?.intentText ?? item.title;
            if (role === "device") await deviceGate.promise;
            if (role === "server") await serverGate.promise;
            return {
              repo: item.repo,
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              checks: [{ name: "fake-unit", status: "pass" }],
              summary: `${role}: autoLockMinutes implemented per contract; tests passed; real hardware not tested`,
              changed: {
                files: [{ path: `src/${role}.ts`, change: "modified", added: 3, removed: 1 }],
                total: 1,
                partial: false,
              },
            };
          },
        });
        subs.push(sub);
        joined.set(role, sub);
        await vi.waitFor(() =>
          expect(master.status().peers.find((p) => p.peerId === sub.peerId)?.role).toBe(role),
        );
      };
      for (const role of ["device", "server", "ios", "android"]) await joinRole(role);
      const skill = loadSkillSource(iotBleFeature, "packaged");
      const peers = () =>
        master.status().peers.map((p) => ({
          peerId: p.peerId,
          device: p.device,
          role: p.role ?? "coding",
          ...(p.repo ? { repo: p.repo } : {}),
          protocolVersion: p.protocol,
        }));
      const prompts: string[] = [];
      const contract =
        "Auto-lock minutes: integer 1..60; HTTP autoLockMinutes; device command TBD by device role.";
      const agent: MasterAgent = {
        cli: "codex",
        conversationId: null,
        contextChars: 0,
        reset() {},
        async turn({ prompt }) {
          prompts.push(prompt);
          return {
            conversationId: "iot-test",
            text:
              prompts.length === 1
                ? JSON.stringify({
                    title: "Add auto-lock",
                    brief: "Implement agreed behaviour",
                    contract,
                    targets: ["device", "server", "ios", "android"].map((role) => ({
                      role,
                      brief: `Implement ${role} contract fields and tests`,
                    })),
                  })
                : "Cross-stack consistency: consistent: autoLockMinutes in every role. Human-only follow-up: real-device BLE bench test.",
          };
        },
      };
      const orchestrator = new Orchestrator({
        agent,
        ledger: null,
        clock: { nowMs: () => 1000, monotonicMs: () => 0, sleep: () => new Promise(() => {}) },
        peers,
        dispatch: async (text, repos, peerIds) =>
          (await master.submitIntent(text, repos, peerIds)).intentId,
        retryItem: async (id) => {
          if (!master.retryItem) throw new Error("missing master retry");
          return master.retryItem(id);
        },
        items: (ids) =>
          master
            .status()
            .intents.filter((i) => ids.includes(i.intentId))
            .flatMap((intent) =>
              intent.items.map(
                (item): OrchestrationItem => ({
                  intentId: intent.intentId,
                  itemId: item.itemId,
                  repo: item.repo,
                  peerId: item.assignee,
                  verdict: itemVerdict(item),
                  ...(item.result
                    ? {
                        summary: item.result.summary,
                        ...(item.result.changed ? { changed: item.result.changed } : {}),
                      }
                    : {}),
                }),
              ),
            ),
        guard: async () => async () => [],
        ask: async () => null,
        confirm: async () => ({ action: "send" }),
        show: () => {},
      });
      const run = orchestrator.start(
        "Add auto-lock configurable in the app and synced to the account",
        "auto",
        { skill, bindings: bind(skill.manifest.roles, peers()) },
      );
      try {
        await vi.waitFor(() => expect(Object.keys(received).sort()).toEqual(["device", "server"]));
        expect(received.device).toContain(
          `FEATURE CONTRACT (shared by all roles; do not change it, report conflicts instead)\n${contract}`,
        );
        if (mode === "retry" || mode === "skip") {
          await joined.get("device")?.close();
          serverGate.release();
          await vi.waitFor(() => {
            orchestrator.poll();
            expect(orchestrator.get(run.id)?.phase).toBe("awaiting-retry");
          });
          expect(received.ios).toBeUndefined();
          expect(received.android).toBeUndefined();
          if (mode === "retry") {
            const original = received.device;
            await joinRole("device");
            expect(await orchestrator.retry(run.id)).toBeNull();
            await vi.waitFor(() => expect(deliveries.device).toBe(2));
            expect(received.device).toBe(original);
          } else {
            expect(orchestrator.skip(run.id)).toBeNull();
          }
        }
        deviceGate.release();
        if (mode !== "skip")
          await vi.waitFor(() => {
            orchestrator.poll();
            expect(
              master
                .status()
                .intents.flatMap((i) => i.items)
                .some((i) => i.repo === "device-repo" && itemVerdict(i) === "done"),
            ).toBe(true);
          });
        if (mode === "normal" || mode === "shared") {
          expect(received.ios).toBeUndefined();
          expect(received.android).toBeUndefined();
        }
        if (mode === "leave-done") await joined.get("device")?.close();
        serverGate.release();
        await vi.waitFor(() => {
          orchestrator.poll();
          expect(Object.keys(received)).toHaveLength(4);
        });
        expect(received.ios).toContain("<<<RESULT earlier stages");
        expect(received.ios).toContain("src/server.ts");
        if (mode !== "skip") expect(received.ios).toContain("src/device.ts");
        else {
          expect(received.ios).toContain("device (skipped after peer lost)");
        }
        expect(received.android?.length).toBeLessThanOrEqual(8000);
        expect(received.ios).toContain("YOUR ROLE: iOS app");
        expect(received.ios).not.toContain("YOUR ROLE: Android app");
        expect(received.android).toContain("YOUR ROLE: Android app");
        await vi.waitFor(() => {
          orchestrator.poll();
          expect(orchestrator.get(run.id)?.phase).toBe("done");
        });
        const state = await run.done;
        expect(state.synthesis).toContain("Cross-stack consistency");
        if (mode === "skip") expect(prompts[1]).toContain("device (skipped after peer lost)");
        expect(state.items).toHaveLength(mode === "retry" ? 5 : 4);
        expect(prompts[1]).toContain("h5 (unbound optional role)");
        expect(state.stages?.map((s) => s.status)).toEqual(["settled", "settled", "settled"]);
      } finally {
        deviceGate.release();
        serverGate.release();
        orchestrator.cancel(run.id);
      }
    },
  );
});
