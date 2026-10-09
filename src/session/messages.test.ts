import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ControlResultSchema,
  FirstFrameSchema,
  HandshakeMsgSchema,
  SessionMsgSchema,
  SessionStatusSchema,
} from "./messages.js";

const pub = Buffer.alloc(32, 1).toString("base64");
const nonce = Buffer.alloc(16, 2).toString("base64");
const token = "a".repeat(32);
const item = {
  itemId: "I-1",
  repo: "app",
  assignee: "peer-1",
  epoch: 1,
  title: "Work",
  datalistEntries: 1,
};
const result = {
  type: "result",
  itemId: "I-1",
  epoch: 1,
  repo: "app",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  checks: [{ name: "test", status: "pass" }],
  summary: "Done",
};
const status = {
  sessionId: "session-1",
  listen: "127.0.0.1:1234",
  repo: "app",
  joinCode: null,
  joinCodeExpiresAtMs: null,
  peers: [
    {
      peerId: "peer-1",
      device: "app",
      address: "127.0.0.1",
      family: "IPv4",
      repo: null,
      head: null,
      role: null,
    },
  ],
  intents: [
    {
      intentId: "intent-1",
      text: "Work",
      state: "planned",
      items: [{ ...item, state: "claimed" }],
    },
  ],
};

const groups: { name: string; schema: z.ZodType; messages: Record<string, unknown>[] }[] = [
  {
    name: "first",
    schema: FirstFrameSchema,
    messages: [
      { type: "control", v: 1, token, op: "status" },
      { type: "control", v: 1, token, op: "intent", text: "Work", repos: ["app"] },
      { type: "join", v: 1, device: "app", pub, nonce },
    ],
  },
  {
    name: "handshake",
    schema: HandshakeMsgSchema,
    messages: [
      { type: "join", v: 1, device: "app", pub, nonce },
      { type: "join-challenge", v: 1, pub, nonce },
      { type: "join-confirm", mac: pub },
      { type: "join-accept", mac: pub },
      { type: "join-reject", reason: "bad_code" },
    ],
  },
  {
    name: "session",
    schema: SessionMsgSchema,
    messages: [
      { type: "welcome", sessionId: "session-1", peerId: "peer-1" },
      { type: "heartbeat", seq: 0 },
      { type: "intent", intentId: "intent-1", text: "Work" },
      {
        type: "capability",
        intentId: "intent-1",
        repo: "app",
        head: "a".repeat(40),
        role: "worker",
      },
      { type: "datalist-request", intentId: "intent-1", requestId: "request-1" },
      {
        type: "datalist",
        intentId: "intent-1",
        requestId: "request-1",
        truncated: false,
        entries: [{ kind: "path", path: "src/app.ts", detail: "App" }],
      },
      { type: "plan", planId: "plan-1", intentId: "intent-1", epoch: 1, items: [item] },
      { type: "claim", itemId: "I-1", epoch: 1 },
      { type: "claim-ack", itemId: "I-1", epoch: 1 },
      { type: "claim-reject", itemId: "I-1", reason: "not_assignee" },
      result,
      { type: "result-ack", itemId: "I-1" },
      { type: "result-reject", itemId: "I-1", reason: "stale_epoch" },
      { type: "bye", reason: "closed" },
    ],
  },
  {
    name: "control result",
    schema: ControlResultSchema,
    messages: [
      { type: "control-result", ok: true, result: status },
      { type: "control-result", ok: true, result: { intentId: "intent-1" } },
      { type: "control-result", ok: false, error: { code: "bad_token", message: "Invalid token" } },
    ],
  },
  { name: "status", schema: SessionStatusSchema, messages: [status] },
];

for (const group of groups) {
  describe(`${group.name} strict schemas`, () => {
    for (const [index, message] of group.messages.entries()) {
      it(`accepts example ${index + 1} and rejects unknown keys at every object level`, () => {
        expect(group.schema.safeParse(message).success).toBe(true);
        for (const mutation of withUnknownKeys(message)) {
          expect(group.schema.safeParse(mutation).success).toBe(false);
        }
      });
    }
  });
}

function withUnknownKeys(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      withUnknownKeys(entry).map((changed) =>
        value.map((other, i) => (i === index ? changed : other)),
      ),
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      { ...record, unknownKey: true },
      ...Object.entries(record).flatMap(([key, entry]) =>
        withUnknownKeys(entry).map((changed) => ({ ...record, [key]: changed })),
      ),
    ];
  }
  return [];
}

it("rejects malformed base64, roles, SHA, limits and protocol versions", () => {
  const join = { type: "join", v: 1, device: "app", pub, nonce };
  for (const change of [
    { v: 2 },
    { device: "App" },
    { pub: `${pub}\n` },
    { pub: pub.slice(0, -1) },
    { nonce: pub },
  ]) {
    expect(FirstFrameSchema.safeParse({ ...join, ...change }).success).toBe(false);
  }
  const control = { type: "control", v: 1, token, op: "intent", text: "Work" };
  for (const change of [
    { text: "" },
    { text: "x".repeat(4001) },
    { repos: [] },
    { repos: Array(17).fill("app") },
    { token: token.toUpperCase() },
  ]) {
    expect(FirstFrameSchema.safeParse({ ...control, ...change }).success).toBe(false);
  }
  expect(SessionMsgSchema.safeParse({ type: "heartbeat", seq: -1 }).success).toBe(false);
  expect(SessionMsgSchema.safeParse({ ...result, baseSha: "fake" }).success).toBe(false);
  expect(
    SessionMsgSchema.safeParse({
      ...result,
      checks: Array(65).fill({ name: "test", status: "pass" }),
    }).success,
  ).toBe(false);
  expect(
    SessionMsgSchema.safeParse({
      type: "capability",
      intentId: "intent-1",
      repo: "app",
      head: "a".repeat(40),
      role: "Bad",
    }).success,
  ).toBe(false);
});
