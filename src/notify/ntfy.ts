/**
 * Human notifications over ntfy (PRD §6.2, ARCHITECTURE §17.5).
 *
 * The topic URL is public config (`device.toml` `notify.ntfy_topic_url`), not a credential: knowing
 * it only lets someone post a message to the human. The body is still redacted before it leaves
 * the device (ARCHITECTURE §16, D19) — agent output can echo a local provider secret, and a
 * notification must not carry one. Nothing here reads provider configuration.
 */

import type { TextRedactor } from "../exec/redact.js";

/** One notification. `message` is unredacted local text; the notifier scrubs it before sending. */
export interface Notification {
  title: string;
  message: string;
  /** ntfy priority 1–5. Defaults to 3 (default). */
  priority?: number;
  /** Short tags (ntfy emoji shortcodes or plain words). */
  tags?: string[];
}

export interface NotifyResult {
  /** True when the server accepted the POST (2xx). */
  delivered: boolean;
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
}

/**
 * Transport for one POST. Production uses `fetch`; tests pass a fake so nothing reaches the
 * network. The body is already redacted by the time it is handed here.
 */
export interface NotifierTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<NotifyResult>;
}

export class NotifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotifyError";
  }
}

const MAX_TITLE_CHARS = 200;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TAGS = 8;

export class NtfyNotifier {
  constructor(
    private readonly deps: {
      /** `device.toml` `notify.ntfy_topic_url`. The topic is not a secret (D19). */
      topicUrl: string;
      redactor: TextRedactor;
      transport?: NotifierTransport;
    },
  ) {
    if (!isHttpUrl(deps.topicUrl)) {
      throw new NotifyError("ntfy topic URL must be an http(s) URL");
    }
  }

  /**
   * POST a redacted message. Never throws for a network or server failure: a notification is a
   * hint to the human, and losing it must not stop the daemon (ARCHITECTURE §17.5).
   */
  async notify(notification: Notification): Promise<NotifyResult> {
    const title = clip(this.deps.redactor.redact(notification.title), MAX_TITLE_CHARS);
    const message = clip(this.deps.redactor.redact(notification.message), MAX_MESSAGE_CHARS);
    const headers: Record<string, string> = { Title: title };
    if (notification.priority !== undefined) {
      headers.Priority = String(clampPriority(notification.priority));
    }
    const tags = (notification.tags ?? [])
      .slice(0, MAX_TAGS)
      .map((tag) => this.deps.redactor.redact(tag))
      .filter((tag) => tag !== "" && !/[\r\n,]/.test(tag));
    if (tags.length > 0) headers.Tags = tags.join(",");
    try {
      return await this.transport().post(this.deps.topicUrl, message, headers);
    } catch {
      // A notification is a hint. Losing it must not fail the caller (ARCHITECTURE §17.5).
      return { delivered: false, status: null };
    }
  }

  private transport(): NotifierTransport {
    return this.deps.transport ?? fetchTransport;
  }
}

/** `fetch` with a bounded timeout. A hang must not stall the caller (the daemon tick). */
const fetchTransport: NotifierTransport = {
  async post(url, body, headers) {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return { delivered: response.ok, status: response.status };
  },
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clampPriority(priority: number): number {
  if (!Number.isInteger(priority)) return 3;
  return Math.min(5, Math.max(1, priority));
}
