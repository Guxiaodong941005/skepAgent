import { describe, expect, it } from "vitest";
import { type ItemStatus, ItemStatusSchema, type ResultMsg } from "./messages.js";
import { applyClaim, applyResult, buildPlan, matchSub } from "./state.js";

const peers = [
  { peerId: "later", repo: "app", joinedOrder: 2 },
  { peerId: "web", repo: "web", joinedOrder: 3 },
  { peerId: "first", repo: "app", joinedOrder: 1 },
];
const item: ItemStatus = {
  itemId: "I-1",
  repo: "app",
  assignee: "first",
  epoch: 1,
  title: "Implement",
  datalistEntries: 0,
  state: "planned",
};
const result: ResultMsg = {
  type: "result",
  itemId: "I-1",
  epoch: 1,
  repo: "app",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  checks: [{ name: "test", status: "pass" }],
  summary: "Done",
};

describe("pure session state", () => {
  it("selects earliest joined peers and builds one item per matched repo", () => {
    expect(matchSub("app", peers)?.peerId).toBe("first");
    expect(matchSub("missing", peers)).toBeNull();
    expect(buildPlan({ text: "Implement" }, "app", peers)).toEqual(
      [{ ...item, state: undefined }].map(({ state: _state, ...entry }) => entry),
    );
    expect(
      buildPlan({ text: "Implement", repos: ["web", "app", "app", "missing"] }, "app", peers),
    ).toMatchObject([
      { itemId: "I-1", repo: "web", assignee: "web" },
      { itemId: "I-2", repo: "app", assignee: "first" },
    ]);
  });

  it("fences claims by assignee, epoch and prior state without mutating input", () => {
    const items = [item];
    const claim = { type: "claim" as const, itemId: "I-1", epoch: 1 };
    expect(applyClaim(items, "web", claim).reply).toMatchObject({ reason: "not_assignee" });
    expect(applyClaim(items, "first", { ...claim, epoch: 2 }).reply).toMatchObject({
      reason: "stale_epoch",
    });
    expect(applyClaim(items, "first", { ...claim, itemId: "I-2" }).reply).toMatchObject({
      reason: "unknown_item",
    });
    const accepted = applyClaim(items, "first", claim);
    expect(accepted.reply.type).toBe("claim-ack");
    expect(item.state).toBe("planned");
    expect(applyClaim(accepted.items, "first", claim).reply).toMatchObject({
      reason: "already_claimed",
    });
    expect(applyClaim([{ ...item, state: "failed" }], "first", claim).reply).toMatchObject({
      reason: "already_claimed",
    });
  });

  it("accepts results only on a claimed item with matching repo/epoch/assignee", () => {
    expect(applyResult([item], "first", result).reply).toMatchObject({ reason: "not_claimed" });
    const claimed: ItemStatus[] = [{ ...item, state: "claimed" }];
    expect(applyResult(claimed, "web", result).reply).toMatchObject({ reason: "not_assignee" });
    expect(applyResult(claimed, "first", { ...result, epoch: 2 }).reply).toMatchObject({
      reason: "stale_epoch",
    });
    expect(applyResult(claimed, "first", { ...result, repo: "web" }).reply).toMatchObject({
      reason: "repo_mismatch",
    });
    expect(applyResult(claimed, "first", { ...result, itemId: "I-2" }).reply).toMatchObject({
      reason: "unknown_item",
    });
    const accepted = applyResult(claimed, "first", result);
    expect(accepted.reply.type).toBe("result-ack");
    expect(accepted.items[0]).toMatchObject({
      state: "done",
      result: { baseSha: result.baseSha, headSha: result.headSha },
    });
    expect(accepted.items[0]?.result).not.toHaveProperty("type");
    expect(claimed[0]?.state).toBe("claimed");
    expect(applyResult(accepted.items, "first", result).reply).toMatchObject({
      reason: "not_claimed",
    });
  });
});

describe("structured submit outcomes", () => {
  const claimed: ItemStatus[] = [{ ...item, state: "claimed" }];

  it("keeps the submit object when it acks a result", () => {
    const submit = {
      method: "pr" as const,
      state: "opened" as const,
      url: "https://example.invalid/app/pull/3",
      number: 3,
      branch: "skep/session/I-1-e1",
    };
    const accepted = applyResult(claimed, "first", { ...result, submit });
    expect(accepted.reply.type).toBe("result-ack");
    expect(accepted.items[0]?.result?.submit).toEqual(submit);
    expect(ItemStatusSchema.parse(accepted.items[0]).result?.submit).toEqual(submit);
  });

  it("still acks a result from a peer that sends no submit", () => {
    const accepted = applyResult(claimed, "first", result);
    expect(accepted.reply.type).toBe("result-ack");
    expect(accepted.items[0]?.result).not.toHaveProperty("submit");
    expect(ItemStatusSchema.safeParse(accepted.items[0]).success).toBe(true);
  });
});
