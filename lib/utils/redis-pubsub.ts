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

  if (!redisUrl) {
    return null;
  }

  try {
    const subscriber = createClient({ url: redisUrl });
    subscriber.on("error", (err) => {
      options.onError?.(err);
    });
    await subscriber.connect();
    return subscriber;
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

/**
 * Get the cancellation channel name for a chat.
 */
export const getCancelChannel = (chatId: string): string => {
  return `stream:cancel:${chatId}`;
};
