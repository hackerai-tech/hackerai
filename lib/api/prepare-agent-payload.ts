import "server-only";

import { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { geolocation } from "@vercel/functions";
import { v4 as uuidv4 } from "uuid";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { checkRateLimit } from "@/lib/rate-limit";
import { getExtraUsageBalance } from "@/lib/extra-usage";
import { countMessagesTokens } from "@/lib/token-utils";
import { ChatSDKError } from "@/lib/errors";
import {
  getMessagesByChatId,
  handleInitialChatAndUserMessage,
  getUserCustomization,
  startTempStream,
} from "@/lib/db/actions";
import { getBaseTodosForRequest } from "@/lib/utils/todo-utils";
import { processChatMessages } from "@/lib/chat/chat-processor";
import { getUploadBasePath } from "@/lib/utils/sandbox-file-utils";
import {
  hasFileAttachments,
  countFileAttachments,
} from "@/lib/api/chat-stream-helpers";
import type {
  ChatMode,
  Todo,
  SandboxPreference,
  ExtraUsageConfig,
  SubscriptionTier,
  RateLimitInfo,
} from "@/types";
import type { UserCustomization } from "@/types/user";
import type { SandboxFile } from "@/lib/utils/sandbox-file-utils";

/** Serializable rate limit info for Trigger.dev payload (Date -> ISO string) */
export type SerializableRateLimitInfo = Omit<
  RateLimitInfo,
  "resetTime" | "session" | "weekly"
> & {
  resetTime: string;
  session?: {
    remaining: number;
    limit: number;
    resetTime: string;
  };
  weekly?: {
    remaining: number;
    limit: number;
    resetTime: string;
  };
};

export type AgentTaskPayload = {
  chatId: string;
  messages: UIMessage[];
  assistantMessageId: string;
  mode: ChatMode;
  todos: Todo[];
  regenerate: boolean;
  temporary: boolean;
  sandboxPreference: SandboxPreference;
  userId: string;
  subscription: SubscriptionTier;
  userLocation: { region?: string; city?: string; country?: string } | null;
  extraUsageConfig: ExtraUsageConfig | null;
  estimatedInputTokens: number;
  memoryEnabled: boolean;
  userCustomization: UserCustomization | null;
  isNewChat: boolean;
  selectedModel: string;
  rateLimitInfo: SerializableRateLimitInfo;
  sandboxFiles?: SandboxFile[];
  fileTokens: Record<string, number>;
  chatFinishReason?: string;
  hasSandboxFiles: boolean;
  hasFileAttachments: boolean;
  fileCount: number;
  fileImageCount: number;
};

function serializeRateLimitInfo(
  info: RateLimitInfo,
): SerializableRateLimitInfo {
  return {
    ...info,
    resetTime:
      typeof info.resetTime === "string"
        ? info.resetTime
        : info.resetTime.toISOString(),
    session: info.session
      ? {
          ...info.session,
          resetTime:
            typeof info.session.resetTime === "string"
              ? info.session.resetTime
              : info.session.resetTime.toISOString(),
        }
      : undefined,
    weekly: info.weekly
      ? {
          ...info.weekly,
          resetTime:
            typeof info.weekly.resetTime === "string"
              ? info.weekly.resetTime
              : info.weekly.resetTime.toISOString(),
        }
      : undefined,
  };
}

/**
 * Runs all pre-stream validation and setup for agent-long mode, then returns
 * a serializable payload for the Trigger.dev agent-stream task.
 * Call this from POST /api/agent-long only when mode === "agent-long".
 */
export async function prepareAgentPayload(
  req: NextRequest,
): Promise<AgentTaskPayload> {
  let parsedBody: {
    messages: UIMessage[];
    mode: ChatMode;
    chatId: string;
    todos?: Todo[];
    regenerate?: boolean;
    temporary?: boolean;
    sandboxPreference?: SandboxPreference;
  };

  try {
    parsedBody = await req.json();
  } catch {
    throw new ChatSDKError(
      "bad_request:api",
      "Invalid or malformed request body",
    );
  }

  const {
    messages,
    mode,
    todos,
    chatId,
    regenerate,
    temporary,
    sandboxPreference,
  } = parsedBody;

  if (mode !== "agent-long") {
    throw new ChatSDKError(
      "bad_request:api",
      "prepareAgentPayload is only for agent-long mode",
    );
  }

  const { userId, subscription } = await getUserIDAndPro(req);
  const userLocation = geolocation(req);

  if (subscription === "free") {
    throw new ChatSDKError(
      "forbidden:chat",
      "Agent-Long mode is only available for Pro users. Please upgrade to access this feature.",
    );
  }

  const {
    truncatedMessages,
    chat,
    isNewChat,
    fileTokens: fileTokensMap,
  } = await getMessagesByChatId({
    chatId,
    userId,
    subscription,
    newMessages: messages,
    regenerate,
    isTemporary: temporary,
    mode,
  });

  const baseTodos: Todo[] = getBaseTodosForRequest(
    (chat?.todos as unknown as Todo[]) || [],
    Array.isArray(todos) ? todos : [],
    { isTemporary: !!temporary, regenerate },
  );

  if (!temporary) {
    await handleInitialChatAndUserMessage({
      chatId,
      userId,
      messages: truncatedMessages,
      regenerate,
      chat,
    });
  }

  const uploadBasePath = getUploadBasePath(sandboxPreference);

  const { processedMessages, selectedModel, sandboxFiles } =
    await processChatMessages({
      messages: truncatedMessages,
      mode,
      subscription,
      uploadBasePath,
    });

  if (!processedMessages || processedMessages.length === 0) {
    throw new ChatSDKError(
      "bad_request:api",
      "Your message could not be processed. Please include some text with your file attachments and try again.",
    );
  }

  const userCustomization = await getUserCustomization({ userId });
  const memoryEnabled = userCustomization?.include_memory_entries ?? true;
  // Note: File tokens are not included because counts are inaccurate (especially PDFs)
  // and deductUsage reconciles with actual provider cost anyway
  const estimatedInputTokens = countMessagesTokens(truncatedMessages);

  // Paid users only (free already rejected above)
  let extraUsageConfig: ExtraUsageConfig | undefined;
  {
    const extraUsageEnabled = userCustomization?.extra_usage_enabled ?? false;
    if (extraUsageEnabled) {
      const balanceInfo = await getExtraUsageBalance(userId);
      if (
        balanceInfo &&
        (balanceInfo.balanceDollars > 0 || balanceInfo.autoReloadEnabled)
      ) {
        extraUsageConfig = {
          enabled: true,
          hasBalance: balanceInfo.balanceDollars > 0,
          balanceDollars: balanceInfo.balanceDollars,
          autoReloadEnabled: balanceInfo.autoReloadEnabled,
        };
      }
    }
  }

  const fileTokens: Record<string, number> =
    typeof fileTokensMap === "number" ? {} : fileTokensMap;

  const fileCounts = countFileAttachments(truncatedMessages);

  const rateLimitInfo = await checkRateLimit(
    userId,
    mode,
    subscription,
    estimatedInputTokens,
    extraUsageConfig,
  );

  const assistantMessageId = uuidv4();

  if (temporary) {
    try {
      await startTempStream({ chatId, userId });
    } catch {
      // Silently continue; temp coordination is best-effort
    }
  }

  return {
    chatId,
    messages: processedMessages,
    assistantMessageId,
    mode,
    todos: baseTodos,
    regenerate: !!regenerate,
    temporary: !!temporary,
    sandboxPreference: sandboxPreference ?? "e2b",
    userId,
    subscription,
    userLocation: userLocation
      ? {
          region: userLocation.region,
          city: userLocation.city,
          country: userLocation.country,
        }
      : null,
    extraUsageConfig: extraUsageConfig ?? null,
    estimatedInputTokens,
    memoryEnabled,
    userCustomization: userCustomization ?? null,
    isNewChat,
    selectedModel,
    rateLimitInfo: serializeRateLimitInfo(rateLimitInfo),
    sandboxFiles,
    fileTokens,
    chatFinishReason: chat?.finish_reason,
    hasSandboxFiles: !!(sandboxFiles && sandboxFiles.length > 0),
    hasFileAttachments: hasFileAttachments(truncatedMessages),
    fileCount: fileCounts.totalFiles,
    fileImageCount: fileCounts.imageCount,
  };
}
