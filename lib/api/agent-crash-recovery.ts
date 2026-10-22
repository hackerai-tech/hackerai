import { assertUserCanAccessChatHistory } from "@/lib/suspensions";
import { streams } from "@trigger.dev/sdk";
import {
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { saveMessage } from "@/lib/db/actions";
import { hasVisibleAssistantContent } from "@/lib/chat/abort-persistence";
import { CLIENT_SAVED_FINISH_REASON } from "@/lib/chat/stop-conditions";

// Failure-only replay budgets, shared by the entire run, not by each message.
// Exceeding them leaves the run attached so recovery can be retried/investigated.
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_REPLAY_RECORDS = 100_000;
const MAX_REPLAY_CHUNKS = 4096;
const MAX_REPLAY_MESSAGES = 16;
const REPLAY_TIMEOUT_MS = 15_000;

export async function recoverCrashedAgentRun({
  chatId,
  userId,
  runId,
  metadata,
}: {
  chatId: string;
  userId: string;
  runId: string;
  metadata: unknown;
}): Promise<"recovered" | "stale"> {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    (metadata as Record<string, unknown>).chatId !== chatId ||
    (metadata as Record<string, unknown>).userId !== userId
  ) {
    throw new Error("Agent crash recovery run ownership mismatch");
  }
  const deadline = Date.now() + REPLAY_TIMEOUT_MS;
  const assertWithinBudget = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new Error("Agent crash recovery timed out");
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  try {
    await assertUserCanAccessChatHistory(userId, {
      retryNetworkFailure: true,
      signal: controller.signal,
    });
    const retained = await streams.read<unknown>(runId, "ui", {
      signal: controller.signal,
      // A crashed producer cannot append more data. Drain retained history;
      // Trigger/S2 closes after one second waiting at its current tail. The
      // independent deadline below must never be accepted as a successful EOF.
      timeoutInSeconds: 1,
    });
    const groups: UIMessageChunk[][] = [];
    let bytes = 0,
      records = 0,
      chunkCount = 0;
    // Buffer only a bounded, complete replay before any writes. In particular,
    // never persist an apparently final prefix after a transport error/timeout.
    for await (const raw of retained) {
      assertWithinBudget();
      if (++records > MAX_REPLAY_RECORDS)
        throw new Error("Agent crash recovery record budget exceeded");
      // The SDK exposes empty S2 control records as undefined.
      if (raw === undefined) continue;
      bytes += Buffer.byteLength(JSON.stringify(raw), "utf8");
      if (bytes > MAX_REPLAY_BYTES)
        throw new Error("Agent crash recovery replay budget exceeded");
      const validated = await uiMessageChunkSchema().validate!(raw);
      if (!validated.success)
        throw new Error("Agent crash recovery invalid stream chunk");
      const chunk = validated.value;
      // UI control events are not conversation history. Provider retries may
      // also leave an error marker before a later assistant message.
      if (chunk.type.startsWith("data-") || chunk.type === "error") continue;
      if (chunk.type === "start") {
        if (!chunk.messageId || groups.length >= MAX_REPLAY_MESSAGES)
          throw new Error("Agent crash recovery message boundary invalid");
        groups.push([]);
      }
      const group = groups.at(-1);
      if (!group)
        throw new Error("Agent crash recovery missing message boundary");
      const previous = group.at(-1);
      // Token deltas must not cause the SDK to clone the whole message once per
      // token. Coalesce adjacent deltas before reconstructing the UI snapshot.
      if (
        previous?.type === "text-delta" &&
        chunk.type === "text-delta" &&
        previous.id === chunk.id
      )
        previous.delta += chunk.delta;
      else if (
        previous?.type === "reasoning-delta" &&
        chunk.type === "reasoning-delta" &&
        previous.id === chunk.id
      )
        previous.delta += chunk.delta;
      else if (
        previous?.type === "tool-input-delta" &&
        chunk.type === "tool-input-delta" &&
        previous.toolCallId === chunk.toolCallId
      )
        previous.inputTextDelta += chunk.inputTextDelta;
      else {
        if (++chunkCount > MAX_REPLAY_CHUNKS)
          throw new Error("Agent crash recovery chunk budget exceeded");
        group.push(chunk);
      }
    }
    assertWithinBudget();
    const recovered: UIMessage[] = [];
    for (const group of groups) {
      let latest: UIMessage | undefined;
      // An OOM need not emit a finish chunk. The SDK reducer can reconstruct
      // that interrupted message without calling a model or executing tools.
      const stream = new ReadableStream<UIMessageChunk>({
        start(c) {
          group.forEach((chunk) => c.enqueue(chunk));
          c.close();
        },
      });
      try {
        for await (const message of readUIMessageStream({
          stream,
          terminateOnError: true,
        })) {
          assertWithinBudget();
          latest = message;
        }
      } catch {
        // Reducer errors may contain streamed tool inputs or provider material.
        throw new Error("Agent crash recovery message reconstruction failed");
      }
      if (latest && hasVisibleAssistantContent([latest]))
        recovered.push(latest);
    }
    assertWithinBudget();
    for (const message of recovered) {
      assertWithinBudget();
      const result = await saveMessage({
        chatId,
        userId,
        message,
        mode: "agent",
        triggerRunId: runId,
        expectedActiveTriggerRunId: runId,
        finishReason: CLIENT_SAVED_FINISH_REASON,
        wasAborted: true,
      });
      if (result === "stale_run") return "stale";
    }
    return "recovered";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
