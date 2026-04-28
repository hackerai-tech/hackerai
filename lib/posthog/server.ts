import PostHogClient from "@/app/posthog";
import type { PostHog } from "posthog-node";

let cachedClient: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (cachedClient === undefined) {
    cachedClient = PostHogClient();
  }
  return cachedClient;
}

type LogFields = Record<string, unknown> & {
  userId?: string;
  error?: unknown;
};

function distinctIdFor(userId: unknown): string {
  return typeof userId === "string" && userId.length > 0 ? userId : "system";
}

export const phLogger = {
  error(message: string, fields: LogFields = {}) {
    const client = getClient();
    if (!client) {
      console.error(message, fields);
      return;
    }
    const { userId, error, ...rest } = fields;
    const exception = error instanceof Error ? error : new Error(message);
    client.captureException(exception, distinctIdFor(userId), {
      message,
      ...rest,
    });
  },

  warn(message: string, fields: LogFields = {}) {
    const client = getClient();
    if (!client) {
      console.warn(message, fields);
      return;
    }
    const { userId, ...rest } = fields;
    client.capture({
      distinctId: distinctIdFor(userId),
      event: "log_warn",
      properties: { message, level: "warning", ...rest },
    });
  },

  info(message: string, fields: LogFields = {}) {
    const client = getClient();
    if (!client) {
      console.log(message, fields);
      return;
    }
    const { userId, ...rest } = fields;
    client.capture({
      distinctId: distinctIdFor(userId),
      event: "log_info",
      properties: { message, level: "info", ...rest },
    });
  },

  async flush(): Promise<void> {
    try {
      await getClient()?.flush();
    } catch {
      // best-effort
    }
  },
};
