import { createHash } from "node:crypto";
import { contentHash } from "../../src/core/canonical.js";
import { eventPath } from "../../src/core/ids.js";
import type { LogEntry, SignatureCheck } from "../../src/core/log.js";
import { DEFAULT_BUDGETS } from "../../src/core/schemas/common.js";
import {
  EVENT_SCHEMA,
  type EventType,
  type PayloadOf,
  type Pre,
  type SkepEvent,
  serializeEvent,
} from "../../src/core/schemas/events.js";
import type { Genesis } from "../../src/core/schemas/genesis.js";
import type { Plan } from "../../src/core/schemas/plan.js";

/**
 * In-memory blackboard log for pure reducer tests: no git, no signing. Each `append` produces a
 * `LogEntry` exactly as the git log reader would for a well-formed commit; use the `mutate` hook
 * to build malformed entries (merge commits, bad signatures, extra files, stale tips, ...).
 */

export const T1 = "T-20261005-7f3a";
export const T2 = "T-20261005-a90c";
export const MAC = "mac.coding";
export const VPS = "vps.coding";

let shaCounter = 0;
/** Deterministic fake 40-hex sha. */
export function fakeSha(label: string | number = shaCounter++): string {
  return createHash("sha1").update(`fake:${label}`).digest("hex");
}

let evtCounter = 0;
export function fakeEventId(n: number = evtCounter++): string {
  const h = createHash("sha256").update(`evt:${n}`).digest("hex");
  return `evt_${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface EventSpec<T extends EventType> {
  type: T;
  task_id?: string | null;
  actor: string;
  payload: PayloadOf<T>;
  pre?: Pre;
  event_id?: string;
}

export interface AppendOptions {
  /** Principal that signed the commit (default: `human` for actor human, else `daemon:<device>`). */
  signer?: string;
  /** Override the computed observed_tip (default: current tip). */
  observedTip?: string;
  /** Last-chance mutation of the produced entry (for structural-violation tests). */
  mutate?: (entry: LogEntry) => void;
}

export function genesisDoc(): Genesis {
  return {
    schema: "skep.genesis/v1",
    protocol_version: 1,
    reducer_version: 1,
    blackboard_id: "bb_test0001",
    created_at: "2026-10-05T00:00:00Z",
  };
}

export class LogBuilder {
  readonly entries: LogEntry[] = [];
  readonly events: (SkepEvent | null)[] = [];

  constructor(genesis: Genesis = genesisDoc()) {
    const sha = fakeSha("genesis");
    this.entries.push({
      seq: 0,
      sha,
      parents: [],
      signature: { status: "good", principal: "human" },
      changes: [{ status: "A", path: "skep.json" }],
      added: { "skep.json": `${JSON.stringify(genesis, null, 2)}\n` },
    });
    this.events.push(null);
  }

  get tip(): string {
    const last = this.entries[this.entries.length - 1];
    if (!last) throw new Error("empty log");
    return last.sha;
  }

  /** Build the event object (not yet appended) against the current tip. */
  event<T extends EventType>(spec: EventSpec<T>, observedTip = this.tip): SkepEvent {
    return {
      schema: EVENT_SCHEMA,
      event_id: spec.event_id ?? fakeEventId(),
      type: spec.type,
      task_id:
        spec.task_id === undefined ? (spec.type === "agent.registered" ? null : T1) : spec.task_id,
      actor: spec.actor,
      observed_tip: observedTip,
      pre: spec.pre ?? {},
      created_at: "2026-10-05T09:00:00Z",
      lang: "en",
      payload: spec.payload,
    } as SkepEvent;
  }

  append<T extends EventType>(spec: EventSpec<T>, opts: AppendOptions = {}): SkepEvent {
    const ev = this.event(spec, opts.observedTip ?? this.tip);
    this.appendRaw(ev, opts);
    return ev;
  }

  /** Append an arbitrary (possibly invalid) JSON value as the single added event file. */
  appendRaw(ev: SkepEvent | Record<string, unknown>, opts: AppendOptions = {}): LogEntry {
    const e = ev as SkepEvent;
    const path = eventPath(e.task_id ?? null, e.event_id);
    const signer = opts.signer ?? defaultSigner(e.actor);
    const signature: SignatureCheck = { status: "good", principal: signer };
    const entry: LogEntry = {
      seq: this.entries.length,
      sha: fakeSha(),
      parents: [this.tip],
      signature,
      changes: [{ status: "A", path }],
      added: { [path]: serializeEvent(e) },
    };
    opts.mutate?.(entry);
    this.entries.push(entry);
    this.events.push(e);
    return entry;
  }
}

function defaultSigner(actor: string): string {
  if (actor === "human") return "human";
  const device = actor.split(".")[0];
  return `daemon:${device}`;
}

// -----------------------------------------------------------------------------------------------
// Payload fixtures
// -----------------------------------------------------------------------------------------------

export function agentRegistered(): PayloadOf<"agent.registered"> {
  return {
    role: "coding",
    agent_cli: "codex",
    cli_version: "0.0.0-test",
    capabilities: ["typescript", "unit-tests"],
    requires_local: [],
    max_parallel_items: 1,
  };
}

export function taskCreated(
  overrides: Partial<PayloadOf<"task.created">> = {},
): PayloadOf<"task.created"> {
  return {
    title: "Add dark mode toggle",
    body: "Add a dark mode toggle to Settings; follow system or manual; persist choice.",
    repo: "git@github.com:owner/myapp.git",
    base_branch: "main",
    mode: "solo",
    owner: VPS,
    budgets: { ...DEFAULT_BUDGETS },
    plan_approval: "human",
    ...overrides,
  };
}

export const BASE_COMMIT = fakeSha("base");

export function samplePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    schema: "skep.plan/v1",
    task_id: T1,
    version: 1,
    parent_version: null,
    base: { repo: "git@github.com:owner/myapp.git", branch: "main", commit: BASE_COMMIT },
    mode: "solo",
    summary: "Make theme runtime-switchable and add the Settings toggle.",
    items: [
      {
        id: "W1",
        title: "Subscribable ThemeProvider + toggle",
        role: "coding",
        assignee: VPS,
        depends_on: [],
        touches: ["src/theme/"],
        risk: "normal",
        acceptance: [{ kind: "check", name: "unit" }],
      },
    ],
    stack_order: ["W1"],
    changes_from_parent: null,
    ...overrides,
  };
}

export function planProposed(plan: Plan = samplePlan(), reviewers: string[] = []) {
  return {
    version: plan.version,
    parent_version: plan.parent_version,
    plan,
    plan_hash: contentHash(plan),
    base_commit: plan.base.commit,
    reviewers,
  } satisfies PayloadOf<"plan.proposed">;
}
