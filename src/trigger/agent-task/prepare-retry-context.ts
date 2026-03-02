"use node";

import { type AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import {
  getLastAssistantMessageFromBackend,
  getChatById,
} from "@/lib/db/actions";
import { ERROR_NOTICE_MARKER } from "./chunk-store";
import { type EarlyAgentStreamContext } from "./context";

export async function prepareRetryContext(
  context: EarlyAgentStreamContext,
  payload: AgentTaskPayload,
): Promise<{
  effectiveIsNewChat: boolean;
  effectiveBaseTodos: typeof payload.todos;
}> {
  const { chatId, userId, todos: baseTodos } = payload;
  const { logger } = await import("@trigger.dev/sdk/v3");

  const [partialMessage, chatData] = await Promise.all([
    getLastAssistantMessageFromBackend({ chatId, userId }),
    getChatById({ id: chatId }),
  ]);

  if (partialMessage) {
    const cleanedParts = partialMessage.parts.map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return { ...part, text: part.text.replace(ERROR_NOTICE_MARKER, "") };
      }
      return part;
    });
    const cleanedPartialMessage = {
      id: partialMessage.id,
      role: "assistant" as const,
      parts: cleanedParts,
    };
    context.finalMessages = [...payload.messages, cleanedPartialMessage];
    logger.info("Retry: loaded partial message from Convex", {
      chatId,
      partialMessageId: partialMessage.id,
    });
  }

  let effectiveBaseTodos = baseTodos;
  if (chatData?.todos && chatData.todos.length > 0) {
    effectiveBaseTodos = chatData.todos;
    logger.info("Retry: restored todos from Convex", {
      chatId,
      todoCount: chatData.todos.length,
    });
  }

  context.activeAssistantMessageId = crypto.randomUUID();
  logger.info("Retry: using new assistant message ID", {
    chatId,
    newAssistantMessageId: context.activeAssistantMessageId,
  });

  return { effectiveIsNewChat: false, effectiveBaseTodos };
}
