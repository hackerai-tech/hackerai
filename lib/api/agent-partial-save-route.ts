import { NextRequest, NextResponse } from "next/server";
import type { UIMessagePart } from "ai";

import { getUserID } from "@/lib/auth/get-user-id";
import { getChatById, saveMessage, updateChat } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { hasVisibleAssistantContent } from "@/lib/chat/abort-persistence";
import { assertUserCanAccessChatHistory } from "@/lib/suspensions";
import { createRedisClient } from "@/lib/rate-limit/redis";

const CLIENT_SAVED_FINISH_REASON = "trigger_crashed_client_saved";
const MAX_PARTIAL_SAVE_BODY_BYTES = 4 * 1024 * 1024;
const PARTIAL_SAVE_RATE_LIMIT_MAX_REQUESTS = 60;
const PARTIAL_SAVE_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

type PartialSaveBody = {
  chatId: string;
  message: {
    id: string;
    role: "assistant";
    parts: UIMessagePart<any, any>[];
  };
  generationStartedAt?: number;
  generationTimeMs?: number;
  clientReason?: string;
};

const getOptionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const throwPartialSavePayloadTooLarge = (): never => {
  throw new ChatSDKError(
    "bad_request:api",
    "Partial save payload is too large.",
  );
};

const assertPartialSaveContentLengthWithinLimit = (req: NextRequest) => {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return;

  const bytes = Number(contentLength);
  if (Number.isFinite(bytes) && bytes > MAX_PARTIAL_SAVE_BODY_BYTES) {
    throwPartialSavePayloadTooLarge();
  }
};

const readRequestTextWithLimit = async (req: NextRequest): Promise<string> => {
  assertPartialSaveContentLengthWithinLimit(req);

  if (!req.body) {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PARTIAL_SAVE_BODY_BYTES) {
      throwPartialSavePayloadTooLarge();
    }
    return text;
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_PARTIAL_SAVE_BODY_BYTES) {
      await reader.cancel();
      throwPartialSavePayloadTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
};

const assertPartialSaveRateLimit = async (userId: string) => {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production") {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Rate limiting service is not configured",
      );
    }
    return;
  }

  const key = `agent_partial_save:${userId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, PARTIAL_SAVE_RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > PARTIAL_SAVE_RATE_LIMIT_MAX_REQUESTS) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Too many partial-save requests. Please wait a moment and try again.",
      );
    }
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    throw new ChatSDKError(
      "rate_limit:chat",
      `Rate limiting service unavailable: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
};

const parsePartialSaveBody = async (
  req: NextRequest,
): Promise<PartialSaveBody> => {
  const text = await readRequestTextWithLimit(req);

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(text);
  } catch {
    throw new ChatSDKError("bad_request:api", "Invalid JSON body");
  }

  if (typeof rawBody !== "object" || rawBody === null) {
    throw new ChatSDKError("bad_request:api", "Invalid JSON body");
  }

  const body = rawBody as Record<string, unknown>;
  const chatId = body.chatId;
  const rawMessage = body.message;

  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new ChatSDKError("bad_request:api", "chatId required");
  }
  if (
    typeof rawMessage !== "object" ||
    rawMessage === null ||
    Array.isArray(rawMessage)
  ) {
    throw new ChatSDKError("bad_request:api", "assistant message required");
  }

  const message = rawMessage as Record<string, unknown>;
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new ChatSDKError("bad_request:api", "message.id required");
  }
  if (message.role !== "assistant") {
    throw new ChatSDKError(
      "bad_request:api",
      "Only assistant messages can be partially saved.",
    );
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new ChatSDKError("bad_request:api", "message.parts required");
  }

  const parsed: PartialSaveBody = {
    chatId,
    message: {
      id: message.id,
      role: "assistant",
      parts: message.parts as UIMessagePart<any, any>[],
    },
    generationStartedAt: getOptionalFiniteNumber(body.generationStartedAt),
    generationTimeMs: getOptionalFiniteNumber(body.generationTimeMs),
    clientReason:
      typeof body.clientReason === "string" ? body.clientReason : undefined,
  };

  if (!hasVisibleAssistantContent([parsed.message])) {
    throw new ChatSDKError(
      "bad_request:api",
      "No visible assistant content to save.",
    );
  }

  return parsed;
};

export const createAgentPartialSavePost =
  () =>
  async (req: NextRequest): Promise<Response> => {
    try {
      const userId = await getUserID(req);
      await assertUserCanAccessChatHistory(userId);
      await assertPartialSaveRateLimit(userId);

      const body = await parsePartialSaveBody(req);
      const chat = await getChatById({ id: body.chatId });
      if (!chat || chat.user_id !== userId) {
        throw new ChatSDKError("forbidden:chat");
      }

      await saveMessage({
        chatId: body.chatId,
        userId,
        message: body.message,
        mode: "agent",
        generationStartedAt: body.generationStartedAt,
        generationTimeMs: body.generationTimeMs,
        finishReason: CLIENT_SAVED_FINISH_REASON,
        wasAborted: true,
      });

      await updateChat({
        chatId: body.chatId,
        finishReason: CLIENT_SAVED_FINISH_REASON,
        defaultModelSlug: "agent",
      });

      console.info(
        JSON.stringify({
          level: "info",
          event: "agent_long_client_partial_saved",
          service: "chat-handler",
          timestamp: new Date().toISOString(),
          chat_id: body.chatId,
          user_id: userId,
          message_id: body.message.id,
          client_reason: body.clientReason,
          part_count: body.message.parts.length,
        }),
      );

      return NextResponse.json({ saved: true });
    } catch (error) {
      if (error instanceof ChatSDKError) return error.toResponse();
      console.error("[agent-partial-save] failed:", error);
      return NextResponse.json(
        { saved: false, message: "Failed to save partial response" },
        { status: 500 },
      );
    }
  };
