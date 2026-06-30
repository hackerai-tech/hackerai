import { createClient } from "redis";

type RedisSubscriberOptions = {
  onError?: (error: unknown) => void;
};

/**
 * Create a dedicated subscriber client for a specific channel.
 * Each subscription needs its own client in Redis pub/sub.
 */
export async function createRedisSubscriber(
  options: RedisSubscriberOptions = {},
) {
  const redisUrl = process.env.REDIS_URL;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.warn("Redis subscriber error:", error);
    });

  if (!redisUrl) {
    return null;
  }

  try {
    const subscriber = createClient({ url: redisUrl });
    subscriber.on("error", (err) => {
      onError(err);
    });
    await subscriber.connect();
    return subscriber;
  } catch (error) {
    onError(error);
    return null;
  }
}

/**
 * Get the cancellation channel name for a chat.
 */
export const getCancelChannel = (chatId: string): string => {
  return `stream:cancel:${chatId}`;
};
