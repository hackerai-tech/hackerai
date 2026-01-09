import { createClient } from "redis";

// Use ReturnType to get the correct client type from createClient
type RedisClient = ReturnType<typeof createClient>;

/**
 * Create a dedicated subscriber client for a specific channel.
 * Each subscription needs its own client in Redis pub/sub.
 */
export const createRedisSubscriber = async (): Promise<RedisClient | null> => {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    return null;
  }

  try {
    const subscriber = createClient({ url: redisUrl });
    subscriber.on("error", (err) => {
      console.error("Redis subscriber error:", err);
    });
    await subscriber.connect();
    return subscriber;
  } catch (error) {
    console.warn("Failed to connect Redis subscriber:", error);
    return null;
  }
};

/**
 * Get the cancellation channel name for a chat.
 */
export const getCancelChannel = (chatId: string): string => {
  return `stream:cancel:${chatId}`;
};
