import { NextRequest, NextResponse } from "next/server";
import type { UIMessagePart } from "ai";

import { getUserID } from "@/lib/auth/get-user-id";
import { getChatById, saveMessage, updateChat } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { hasVisibleAssistantContent } from "@/lib/chat/abort-persistence";
import { assertUserCanAccessChatHistory } from "@/lib/suspensions";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { verifyAgentRunCorrelationToken } from "@/lib/api/agent-run-correlation";

import { CLIENT_SAVED_FINISH_REASON } from "@/lib/chat/stop-conditions";
const MAX_PARTIAL_SAVE_BODY_BYTES = 4 * 1024 * 1024;
const PARTIAL_SAVE_RATE_LIMIT_MAX_REQUESTS = 60;
const PARTIAL_SAVE_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const PARTIAL_SAVE_RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlSeconds = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
  redis.call("EXPIRE", key, ttlSeconds)
end

if count > limit then
  return 0
end

return 1
`;

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
  triggerRunId: string;
  runCorrelationToken: string;
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
  if (!redis) return;

  const key = `agent_partial_save:${userId}`;
  try {
    const result = await redis.eval(
      PARTIAL_SAVE_RATE_LIMIT_SCRIPT,
      [key],
      [
        PARTIAL_SAVE_RATE_LIMIT_MAX_REQUESTS,
        PARTIAL_SAVE_RATE_LIMIT_WINDOW_SECONDS,
      ],
    );
    if (Number(result) !== 1) {
      throw new ChatSDKError(
        "rate_limit:chat",
        "Too many partial-save requests. Please wait a moment and try again.",
      );
    }
  } catch (error) {
    if (error instanceof ChatSDKError) throw error;
    console.warn(
      "[agent-partial-save] rate limit unavailable, continuing partial save:",
      error,
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

  const triggerRunId =
    typeof body.triggerRunId === "string" && body.triggerRunId.length > 0
      ? body.triggerRunId
      : undefined;
  const runCorrelationToken =
    typeof body.runCorrelationToken === "string" &&
    body.runCorrelationToken.length > 0
      ? body.runCorrelationToken
      : undefined;
  if (!triggerRunId || !runCorrelationToken) {
    throw new ChatSDKError(
      "bad_request:api",
      "Agent run correlation is incomplete.",
    );
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
    triggerRunId,
    runCorrelationToken,
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
    let stage:
      | "identify_user"
      | "history_access"
      | "rate_limit"
      | "parse_request"
      | "chat_lookup"
      | "run_correlation"
      | "save_message"
      | "update_chat" = "identify_user";
    let userId: string | undefined;
    let body: PartialSaveBody | undefined;
    let correlationVerified = false;
    let messageSaveCompleted = false;
    try {
      userId = await getUserID(req);
      stage = "history_access";
      await assertUserCanAccessChatHistory(userId);
      stage = "rate_limit";
      await assertPartialSaveRateLimit(userId);

      stage = "parse_request";
      body = await parsePartialSaveBody(req);
      stage = "chat_lookup";
      const chat = await getChatById({ id: body.chatId });
      if (!chat || chat.user_id !== userId) {
        throw new ChatSDKError("forbidden:chat");
      }
      stage = "run_correlation";
      if (
        !verifyAgentRunCorrelationToken({
          token: body.runCorrelationToken,
          userId,
          chatId: body.chatId,
          runId: body.triggerRunId,
        })
      ) {
        throw new ChatSDKError("forbidden:chat");
      }

      correlationVerified = true;
      stage = "save_message";
      await saveMessage({
        chatId: body.chatId,
        userId,
        message: body.message,
        mode: "agent",
        generationStartedAt: body.generationStartedAt,
        generationTimeMs: body.generationTimeMs,
        finishReason: CLIENT_SAVED_FINISH_REASON,
        triggerRunId: body.triggerRunId,
        wasAborted: true,
      });
      messageSaveCompleted = true;

      if (!chat.finish_reason) {
        stage = "update_chat";
        await updateChat({
          chatId: body.chatId,
          finishReason: CLIENT_SAVED_FINISH_REASON,
          defaultModelSlug: "agent",
        });
      }

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
      const requestId = req.headers.get("x-vercel-id");
      const causeCode =
        error instanceof Error && error.cause instanceof Error
          ? (error.cause as NodeJS.ErrnoException).code
          : undefined;
      const transportCode =
        causeCode &&
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "ENOTFOUND",
          "EAI_AGAIN",
          "UND_ERR_SOCKET",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
        ].includes(causeCode)
          ? causeCode
          : undefined;
      // Error objects can carry private arguments. Emit only bounded reasons
      // and identifiers of known shapes; a client run is authoritative only
      // after its ownership and correlation checks have passed.
      console.error(
        JSON.stringify({
          level: "error",
          event: "agent_long_client_partial_save_failed",
          service: "chat-handler",
          route: "/api/agent/partial-save",
          timestamp: new Date().toISOString(),
          stage,
          outcome: "error",
          status_code: 500,
          reason:
            error instanceof TypeError && error.message === "fetch failed"
              ? "network_fetch_failed"
              : "unexpected_error",
          error_type:
            error instanceof TypeError
              ? "TypeError"
              : error instanceof Error
                ? "Error"
                : "NonError",
          transport_code: transportCode,
          request_id:
            requestId &&
            requestId.length <= 128 &&
            /^(?:[a-z0-9-]{1,32}::)?[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/.test(
              requestId,
            )
              ? requestId
              : undefined,
          user_id:
            userId && /^user_[0-9A-HJKMNP-TV-Z]{26}$/.test(userId)
              ? userId
              : undefined,
          requested_chat_id:
            body &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              body.chatId,
            )
              ? body.chatId
              : undefined,
          trigger_run_id:
            correlationVerified &&
            body &&
            /^run_[a-z0-9]{20,32}$/.test(body.triggerRunId)
              ? body.triggerRunId
              : undefined,
          run_correlation_verified: correlationVerified,
          message_save_completed: messageSaveCompleted,
        }),
      );
      return NextResponse.json(
        { saved: false, message: "Failed to save partial response" },
        { status: 500 },
      );
    }
  };
