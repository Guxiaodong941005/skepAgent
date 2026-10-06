import { describe, expect, it } from "vitest";
import { Redactor } from "../exec/redact.js";
import { type NotifierTransport, NotifyError, NtfyNotifier } from "./ntfy.js";

const TOPIC = "https://ntfy.example.com/skep-mac";

function transport(result = { delivered: true, status: 200 }): {
  posts: { url: string; body: string; headers: Record<string, string> }[];
  transport: NotifierTransport;
} {
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  return {
    posts,
    transport: {
      post: async (url, body, headers) => {
        posts.push({ url, body, headers });
        return result;
      },
    },
  };
}

describe("NtfyNotifier", () => {
  it("posts the message body to the topic URL", async () => {
    const fake = transport();
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: fake.transport,
    });
    const result = await notifier.notify({ title: "task escalated", message: "needs a decision" });
    expect(result).toEqual({ delivered: true, status: 200 });
    expect(fake.posts).toEqual([
      {
        url: TOPIC,
        body: "needs a decision",
        headers: { Title: "task escalated" },
      },
    ]);
  });

  it("redacts provider secrets out of the body before sending (D19)", async () => {
    const fake = transport();
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: fake.transport,
    });
    const secret = "sk-liveSecretValue1234567890";
    await notifier.notify({
      title: `failed with ${secret}`,
      message: `the agent printed ${secret} in its log`,
      tags: [`token ${secret}`],
    });
    const post = fake.posts[0];
    expect(post?.body).not.toContain(secret);
    expect(post?.body).toContain("[REDACTED:provider-api-key]");
    expect(post?.headers.Title).not.toContain(secret);
    expect(JSON.stringify(post?.headers)).not.toContain(secret);
  });

  it("redacts a private key block that spans lines", async () => {
    const fake = transport();
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: fake.transport,
    });
    const block = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "aGVsbG8td29ybGQ=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    await notifier.notify({ title: "key", message: `found\n${block}\nafter` });
    expect(fake.posts[0]?.body).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(fake.posts[0]?.body).toContain("[REDACTED:private-key]");
    expect(fake.posts[0]?.body).toContain("after");
  });

  it("returns a failed delivery instead of throwing when the transport rejects", async () => {
    const failing: NotifierTransport = { post: () => Promise.reject(new Error("offline")) };
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: failing,
    });
    await expect(notifier.notify({ title: "t", message: "m" })).resolves.toEqual({
      delivered: false,
      status: null,
    });
  });

  it("reports a non-2xx response as not delivered", async () => {
    const fake = transport({ delivered: false, status: 429 });
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: fake.transport,
    });
    expect(await notifier.notify({ title: "t", message: "m" })).toEqual({
      delivered: false,
      status: 429,
    });
  });

  it("rejects a topic URL that is not http(s)", () => {
    expect(
      () =>
        new NtfyNotifier({ topicUrl: "git@example.com:owner/bb.git", redactor: new Redactor() }),
    ).toThrow(NotifyError);
  });

  it("sends priority and tags when given", async () => {
    const fake = transport();
    const notifier = new NtfyNotifier({
      topicUrl: TOPIC,
      redactor: new Redactor(),
      transport: fake.transport,
    });
    await notifier.notify({ title: "t", message: "m", priority: 5, tags: ["warning", "skep"] });
    expect(fake.posts[0]?.headers.Priority).toBe("5");
    expect(fake.posts[0]?.headers.Tags).toBe("warning,skep");
  });
});
