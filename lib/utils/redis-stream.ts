import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

// Singleton write client — reuse one TCP connection for all XADD calls.
// Redis v5+ multiplexes commands over a single connection.
let writeClient: RedisClient | null = null;
let writeClientConnecting: Promise<RedisClient | null> | null = null;

function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL;
}

/**
 * Lazy singleton write client with reconnection handling.
 * Returns null if REDIS_URL is not configured.
 */
export async function getWriteClient(): Promise<RedisClient | null> {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;

  if (writeClient?.isReady) return writeClient;

  // Avoid multiple concurrent connection attempts
  if (writeClientConnecting) return writeClientConnecting;

  writeClientConnecting = (async () => {
    try {
      // Clean up old client if it exists but isn't ready
      if (writeClient) {
        try {
          await writeClient.quit();
        } catch {
          // ignore cleanup errors
        }
      }

      writeClient = createClient({ url: redisUrl });
      writeClient.on("error", (err) => {
        console.error("[redis-stream] Write client error:", err);
      });
      await writeClient.connect();
      return writeClient;
    } catch (error) {
      console.warn("[redis-stream] Failed to connect write client:", error);
      writeClient = null;
      return null;
    } finally {
      writeClientConnecting = null;
    }
  })();

  return writeClientConnecting;
}

/**
 * Returns the Redis stream key for a chat's chunks.
 */
export function getStreamKey(chatId: string): string {
  return `stream:chunks:${chatId}`;
}

const STREAM_TTL_SECONDS = 3600; // 1 hour

/**
 * Append a UIMessageChunk to the Redis stream for a chat.
 * Fire-and-forget: never throws, returns entry ID or null on failure.
 */
export async function appendChunk(
  chatId: string,
  chunk: unknown,
): Promise<string | null> {
  try {
    const client = await getWriteClient();
    if (!client) return null;

    const key = getStreamKey(chatId);
    const entryId = await client.xAdd(key, "*", {
      data: JSON.stringify(chunk),
    });
    // Refresh TTL on every write to prevent expiry during long runs
    await client.expire(key, STREAM_TTL_SECONDS);
    return entryId;
  } catch (error) {
    console.warn("[redis-stream] appendChunk failed:", error);
    return null;
  }
}

/**
 * Write the __done sentinel to mark end of stream.
 * Fire-and-forget: never throws.
 */
export async function markStreamDone(chatId: string): Promise<void> {
  try {
    const client = await getWriteClient();
    if (!client) return;

    const key = getStreamKey(chatId);
    await client.xAdd(key, "*", { data: "__done" });
    await client.expire(key, STREAM_TTL_SECONDS);
  } catch (error) {
    console.warn("[redis-stream] markStreamDone failed:", error);
  }
}

/**
 * Create a dedicated Redis client for XREAD BLOCK operations.
 * Each SSE endpoint request gets its own client because XREAD BLOCK
 * ties up the connection.
 */
export async function createStreamReader(): Promise<RedisClient | null> {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;

  try {
    const client = createClient({ url: redisUrl });
    client.on("error", (err) => {
      console.error("[redis-stream] Reader client error:", err);
    });
    await client.connect();
    return client;
  } catch (error) {
    console.warn("[redis-stream] Failed to connect reader client:", error);
    return null;
  }
}

/**
 * Read chunks from a Redis stream using XREAD BLOCK.
 * Returns entries or null if the block times out / stream doesn't exist yet.
 */
export async function readChunks(
  client: RedisClient,
  chatId: string,
  lastId: string,
  blockMs: number = 5000,
): Promise<Array<{ id: string; data: string }> | null> {
  try {
    const key = getStreamKey(chatId);
    const result = await client.xRead(
      { key, id: lastId },
      { BLOCK: blockMs, COUNT: 100 },
    );

    if (!result) return null;

    // result is [{ name: key, messages: [{ id, message: { data } }] }]
    const streams = result as Array<{
      name: string;
      messages: Array<{ id: string; message: Record<string, string> }>;
    }>;
    if (streams.length === 0) return null;

    const stream = streams[0];
    if (!stream || stream.messages.length === 0) return null;

    return stream.messages.map((msg) => ({
      id: msg.id,
      data: msg.message.data ?? "",
    }));
  } catch (error) {
    console.warn("[redis-stream] readChunks failed:", error);
    return null;
  }
}

/**
 * Create a ReadableStream that reads parsed UIMessageChunks from Redis.
 * Used by both the POST handler (when Redis streaming is enabled) and the
 * GET reconnect endpoint. Wrap the result with createUIMessageStreamResponse()
 * so the client receives a standard UIMessageStream.
 */
export function createRedisChunkReadable(
  chatId: string,
  startIndex: string = "0-0",
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const reader = await createStreamReader();
      if (!reader) {
        controller.close();
        return;
      }

      let lastId = startIndex;

      try {
        while (true) {
          const entries = await readChunks(reader, chatId, lastId);
          if (!entries) continue;
          console.log(
            "[redis-reader] got",
            entries.length,
            "entries, lastId:",
            lastId,
          );

          for (const entry of entries) {
            lastId = entry.id;

            // Check for __done sentinel
            if (entry.data === "__done") {
              controller.close();
              await reader.quit().catch(() => {});
              return;
            }

            // Parse the stored JSON chunk and enqueue it
            try {
              controller.enqueue(JSON.parse(entry.data));
            } catch {
              // Skip malformed entries
            }
          }
        }
      } catch (error) {
        console.warn("[redis-stream] chunk readable error:", error);
      } finally {
        await reader.quit().catch(() => {});
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
}
