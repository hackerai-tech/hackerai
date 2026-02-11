"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { createClient } from "redis";

/**
 * Internal action to publish cancellation signal via Redis pub/sub.
 * This enables instant notification to the streaming backend instead of polling.
 *
 * Called from cancelStreamFromClient and cancelTempStreamFromClient mutations.
 */
export const publishCancellation = internalAction({
  args: {
    chatId: v.string(),
    skipSave: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      return false;
    }

    let client;
    try {
      client = createClient({ url: redisUrl });
      client.on("error", () => {});

      await client.connect();

      const channel = `stream:cancel:${args.chatId}`;
      await client.publish(
        channel,
        JSON.stringify({
          canceled: true,
          ...(args.skipSave && { skipSave: true }),
        }),
      );

      return true;
    } catch (error) {
      console.error("[Redis Pub/Sub] Failed to publish cancellation:", error);
      return false;
    } finally {
      if (client) {
        try {
          await client.quit();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  },
});
