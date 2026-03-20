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
 * Delete the Redis stream for a chat, resetting it for a new run.
 * Must be called before starting a new run to prevent old chunks from
 * being replayed when the new stream reader starts from "0-0".
 * Fire-and-forget: never throws.
 */
export async function resetStream(chatId: string): Promise<void> {
  try {
    const client = await getWriteClient();
    if (!client) return;
    await client.del(getStreamKey(chatId));
  } catch (error) {
    console.warn("[redis-stream] resetStream failed:", error);
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
/**
 * Check whether the Redis stream key for a chat exists.
 * Used by the reconnect endpoint to detect stale streams (e.g., TTL expired)
 * and return a finish response immediately instead of blocking in XREAD.
 */
export async function streamKeyExists(chatId: string): Promise<boolean> {
  try {
    const client = await getWriteClient();
    if (!client) return false;
    return (await client.exists(getStreamKey(chatId))) === 1;
  } catch {
    return false;
  }
}

/**
 * Return the number of entries in the Redis stream for a chat.
 * Returns 0 if the key doesn't exist or on error.
 */
export async function getStreamLength(chatId: string): Promise<number> {
  try {
    const client = await getWriteClient();
    if (!client) return 0;
    return await client.xLen(getStreamKey(chatId));
  } catch {
    return 0;
  }
}

/**
 * Convert a startIndex (which may be a sequential chunk counter from
 * WorkflowChatTransport, or a Redis stream ID) to a valid Redis stream ID.
 *
 * WorkflowChatTransport sends sequential chunk counters (0, 336, 6225) as
 * startIndex, but Redis XREAD expects stream IDs (timestamp-sequence format,
 * e.g. "1773935459492-0"). Sequential numbers are always less than real
 * timestamp-based IDs, causing XREAD to return ALL entries from the beginning.
 *
 * This function resolves the chunk counter to the corresponding Redis stream
 * entry ID by skipping the first N entries.
 */
export async function resolveStartId(
  chatId: string,
  startIndex: string,
): Promise<string> {
  // Already a Redis stream ID (contains "-")
  if (startIndex.includes("-")) return startIndex;

  const offset = parseInt(startIndex, 10);
  if (isNaN(offset) || offset <= 0) return "0-0";

  try {
    const client = await getWriteClient();
    if (!client) return "0-0";

    const key = getStreamKey(chatId);
    const streamLen = await client.xLen(key);

    if (offset >= streamLen) {
      // Offset is past the end — position at the last entry so XREAD
      // blocks for genuinely new entries instead of replaying everything.
      const last = await client.xRevRange(key, "+", "-", { COUNT: 1 });
      return last.length > 0 ? last[0].id : "0-0";
    }

    // Skip the first `offset` entries and return the last skipped entry's ID.
    // XREAD returns entries AFTER this ID, so we resume from the right spot.
    const entries = await client.xRange(key, "-", "+", { COUNT: offset });
    return entries.length > 0 ? entries[entries.length - 1].id : "0-0";
  } catch {
    return "0-0";
  }
}

/**
 * Maximum consecutive empty XREAD BLOCK responses before closing:
 * - Default (no checkpoint seen): 6 × 5s = 30s of silence
 * - After checkpoint: 24 × 5s = 2min to allow for step transition
 *
 * MAX_TOTAL_EMPTY_READS caps the absolute wait regardless of checkpoint
 * resets, so a crashed workflow doesn't block forever.
 */
const MAX_CONSECUTIVE_EMPTY_READS = 6;
const MAX_CONSECUTIVE_EMPTY_READS_AFTER_CHECKPOINT = 24;
const MAX_TOTAL_EMPTY_READS = 36; // ~3 minutes absolute cap

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
      let consecutiveEmptyReads = 0;
      let totalEmptyReads = 0;
      let sawCheckpoint = false;

      try {
        while (true) {
          const entries = await readChunks(reader, chatId, lastId);
          if (!entries) {
            consecutiveEmptyReads++;
            totalEmptyReads++;
            const threshold = sawCheckpoint
              ? MAX_CONSECUTIVE_EMPTY_READS_AFTER_CHECKPOINT
              : MAX_CONSECUTIVE_EMPTY_READS;
            if (
              consecutiveEmptyReads >= threshold ||
              totalEmptyReads >= MAX_TOTAL_EMPTY_READS
            ) {
              console.warn(
                `[redis-stream] stale stream for chat ${chatId} (consecutive=${consecutiveEmptyReads}, total=${totalEmptyReads}, checkpoint=${sawCheckpoint}), closing`,
              );
              // Emit a synthetic finish so WorkflowChatTransport stops
              // reconnecting. Without this, the transport sees the stream
              // end without a "finish" chunk and retries indefinitely.
              try {
                controller.enqueue({ type: "finish", finishReason: "stop" });
              } catch {
                // Controller already closed
              }
              break;
            }
            continue;
          }
          consecutiveEmptyReads = 0;

          for (const entry of entries) {
            lastId = entry.id;

            // Check for __done sentinel
            if (entry.data === "__done") {
              try {
                controller.close();
              } catch {
                // Controller already closed (client disconnected)
              }
              await reader.quit().catch(() => {});
              return;
            }

            // Checkpoint marker: the workflow step is transitioning to a
            // new step. Reset the consecutive counter and extend the timeout
            // so we keep waiting for the next step's chunks.
            if (entry.data === '"__checkpoint"') {
              sawCheckpoint = true;
              consecutiveEmptyReads = 0;
              continue;
            }

            // Parse the stored JSON chunk and enqueue it
            try {
              controller.enqueue(JSON.parse(entry.data));
            } catch {
              // Skip malformed entries or closed controller
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
