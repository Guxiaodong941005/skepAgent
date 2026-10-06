import { describe, expect, it } from "vitest";
import type { StatusView } from "../core/reducer/views.js";
import {
  type AgentLiveness,
  formatDuration,
  livenessLabel,
  renderLog,
  renderStatus,
  revokeSuggestions,
  type StatusExtras,
} from "./render-status.js";

const TASK = "T-20261005-7f3a";
const OTHER = "T-20261005-a90c";
const MAC = "mac.coding";
const VPS = "vps.coding";

/** 3 × the 60 s lease interval is 3 min; `staleMs` is 5 min. The gap between them is `late`. */
const LEASE_INTERVAL_MS = 60_000;
const IDLE_INTERVAL_MS = 300_000;

function agent(over: Partial<AgentLiveness> & Pick<AgentLiveness, "agent">): AgentLiveness {
  return {
    cls: "live",
    sinceChangeMs: 12_000,
    intervalMs: LEASE_INTERVAL_MS,
    bootId: "b_91c2",
    state: "running",
    runtime: "native",
    lease: null,
    ...over,
  };
}

function view(): StatusView {
  return {
    seq: 437,
    tip: "9d2e4b1c0ffee000000000000000000000000000",
    agents: [
      {
        id: MAC,
        device: "mac",
        agent_cli: "codex",
        cli_version: "0.0.0-test",
        max_parallel_items: 1,
      },
      {
        id: VPS,
        device: "vps",
        agent_cli: "codex",
        cli_version: "0.0.0-test",
        max_parallel_items: 2,
      },
    ],
    tasks: [
      {
        task_id: OTHER,
        status: "awaiting_approval",
        mode: "solo",
        owner: VPS,
        owner_gen: 1,
        current_plan_version: 1,
        active_plan_version: null,
        items: [
          {
            id: "W1",
            status: "ready",
            assignee: VPS,
            epoch: null,
            holder: null,
            parked: false,
          },
        ],
        barrier: null,
        escalation: null,
        verified: null,
        replan_count: 0,
        replan_budget: 2,
        review_rounds: 0,
        review_round_budget: 2,
      },
      {
        task_id: TASK,
        status: "executing",
        mode: "team",
        owner: VPS,
        owner_gen: 1,
        current_plan_version: 2,
        active_plan_version: 2,
        items: [
          {
            id: "W1",
            status: "delivered",
            assignee: VPS,
            epoch: 2,
            holder: null,
            parked: false,
          },
          {
            id: "W2",
            status: "leased",
            assignee: MAC,
            epoch: 2,
            holder: MAC,
            parked: false,
          },
        ],
        barrier: null,
        escalation: null,
        verified: null,
        replan_count: 1,
        replan_budget: 2,
        review_rounds: 0,
        review_round_budget: 2,
      },
    ],
  };
}

function extras(over: Partial<StatusExtras> = {}): StatusExtras {
  return {
    liveness: [
      agent({ agent: MAC, sinceChangeMs: 41_000, lease: { task: TASK, item: "W2", epoch: 2 } }),
      agent({
        agent: VPS,
        sinceChangeMs: 12_000,
        intervalMs: IDLE_INTERVAL_MS,
        state: "idle",
        bootId: "b_5a1e",
        lease: null,
      }),
    ],
    freshness: { checkedAtMonoMs: 1_000, invalidCount: 0, reducerVersion: 1 },
    hints: { name: "null", connected: false, lastMessageMonoMs: null },
    alarms: [],
    nowMonoMs: 7_000,
    ...over,
  };
}

describe("liveness labels (F20)", () => {
  it("labels the gap between 3 × interval and staleMs as late", () => {
    // 3 min exactly is still inside the live window; one millisecond later is late.
    expect(livenessLabel(agent({ agent: MAC, cls: "unknown", sinceChangeMs: 180_000 }))).toBe(
      "unknown",
    );
    expect(livenessLabel(agent({ agent: MAC, cls: "unknown", sinceChangeMs: 180_001 }))).toBe(
      "late",
    );
    // staleMs is 5 min: the gap ends there and the tracker class takes over.
    expect(livenessLabel(agent({ agent: MAC, cls: "unknown", sinceChangeMs: 299_999 }))).toBe(
      "late",
    );
    expect(livenessLabel(agent({ agent: MAC, cls: "stale", sinceChangeMs: 300_000 }))).toBe(
      "stale",
    );
  });

  it("keeps a tracker class that is already live, stale or lost", () => {
    expect(livenessLabel(agent({ agent: MAC, cls: "live", sinceChangeMs: 200_000 }))).toBe("live");
    expect(livenessLabel(agent({ agent: MAC, cls: "lost", sinceChangeMs: 200_000 }))).toBe("lost");
  });

  it("does not call an idle agent late inside its longer window", () => {
    // Idle interval is 300 s, so 3 × interval is 15 min — past staleMs. No gap exists.
    expect(
      livenessLabel(
        agent({ agent: VPS, cls: "unknown", intervalMs: IDLE_INTERVAL_MS, sinceChangeMs: 200_000 }),
      ),
    ).toBe("unknown");
  });
});

describe("renderStatus", () => {
  it("matches the PRD §15.1 columns and says checked, not fetched (F20)", () => {
    const text = renderStatus(view(), extras());
    const [header, , taskHead, firstTask, secondTask, , agentHead, mac, vps] = text
      .trimEnd()
      .split("\n");
    expect(header).toBe(
      "blackboard main #437 (9d2e4b1) · checked 6s ago · reducer v1 · 0 invalid commits · hints off",
    );
    expect(taskHead).toContain("TASK");
    expect(taskHead).toContain("REPLAN");
    expect(taskHead).toContain("ITEMS");
    // Task ids sort, so the awaiting-approval task comes after the executing one.
    expect(firstTask).toContain(OTHER);
    expect(firstTask).toContain("awaiting_approval");
    expect(firstTask).toContain("v1");
    expect(firstTask).not.toContain("v1✔");
    expect(secondTask).toContain(TASK);
    expect(secondTask).toContain("v2✔");
    expect(secondTask).toContain("1/2");
    expect(secondTask).toContain("W1 delivered e2");
    expect(secondTask).toContain(`W2 leased e2 ${MAC}`);
    expect(agentHead).toContain("LIVENESS (here)");
    expect(mac).toContain("live (hb 41s)");
    expect(mac).toContain(`${TASK}/W2 e2`);
    expect(mac).toContain("b_91c2");
    expect(vps).toContain("idle");
    expect(vps).toContain("b_5a1e");
  });

  it("says never when the blackboard has not been checked", () => {
    const text = renderStatus(
      view(),
      extras({ freshness: { checkedAtMonoMs: null, invalidCount: 2 } }),
    );
    expect(text).toContain("checked never");
    expect(text).toContain("2 invalid commits");
  });

  it("shows hint-channel health without treating hints as authority (D18)", () => {
    const text = renderStatus(
      view(),
      extras({ hints: { name: "relay", connected: true, lastMessageMonoMs: 1_000 } }),
    );
    expect(text).toContain("hints relay up, last 6s ago");
    const down = renderStatus(
      view(),
      extras({ hints: { name: "relay", connected: false, lastMessageMonoMs: null } }),
    );
    expect(down).toContain("hints relay down, no messages");
  });

  it("renders an alarm and nothing about providers (D19)", () => {
    const text = renderStatus(
      view(),
      extras({ alarms: [{ kind: "duplicate-daemon", detail: `${MAC} boot b_1111 returned` }] }),
    );
    expect(text).toContain(`! duplicate-daemon: ${MAC} boot b_1111 returned`);
    expect(text).not.toMatch(/provider|credential|api_key|openai|anthropic/i);
  });

  it("suggests a revoke only for a stale or lost holder", () => {
    const stale = extras({
      liveness: [
        agent({
          agent: MAC,
          cls: "stale",
          sinceChangeMs: 400_000,
          lease: { task: TASK, item: "W2", epoch: 2 },
        }),
        agent({ agent: VPS, cls: "live", sinceChangeMs: 1_000, intervalMs: IDLE_INTERVAL_MS }),
      ],
    });
    const text = renderStatus(view(), stale);
    expect(text).toContain(`stale (hb ${formatDuration(400_000)})`);
    expect(text).toContain("revoke suggested");
    expect(text).toContain(`skep lease revoke ${TASK} W2 --epoch 2`);
    expect(revokeSuggestions(view(), stale)).toEqual([
      {
        task: TASK,
        item: "W2",
        epoch: 2,
        holder: MAC,
        label: "stale",
        command: `skep lease revoke ${TASK} W2 --epoch 2`,
      },
    ]);
  });

  it("does not suggest a revoke for a late holder or a parked lease", () => {
    const late = extras({
      liveness: [agent({ agent: MAC, cls: "unknown", sinceChangeMs: 200_000 })],
    });
    expect(revokeSuggestions(view(), late)).toEqual([]);
    expect(renderStatus(view(), late)).toContain("late (hb 3m)");
    expect(renderStatus(view(), late)).not.toContain("revoke suggested");

    const parked = view();
    const item = parked.tasks[1]?.items[1];
    if (!item) throw new Error("fixture item missing");
    item.parked = true;
    item.status = "interrupted";
    const lost = extras({
      liveness: [agent({ agent: MAC, cls: "lost", sinceChangeMs: 1_000_000 })],
    });
    expect(revokeSuggestions(parked, lost)).toEqual([]);
  });
});

describe("renderLog", () => {
  it("shows each outcome with its actor and reason", () => {
    const text = renderLog(TASK, [
      {
        seq: 3,
        sha: "abc",
        outcome: "accepted",
        reason: null,
        event_id: null,
        type: "plan.approved",
        task_id: TASK,
        actor: "human",
        signer: "human",
      },
      {
        seq: 4,
        sha: "def",
        outcome: "rejected",
        reason: "unauthorized",
        event_id: null,
        type: "lease.claimed",
        task_id: TASK,
        actor: VPS,
        signer: "daemon:vps",
      },
    ]);
    expect(text).toBe(
      [
        `#3  accepted  human  plan.approved`,
        `#4  rejected  ${VPS}  lease.claimed  unauthorized`,
        "",
      ].join("\n"),
    );
  });

  it("says so when the task has no events", () => {
    expect(renderLog(TASK, [])).toBe(`log ${TASK}: no events\n`);
  });
});
