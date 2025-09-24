import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage, UIMessagePart } from "ai";
import { extractFileIdsFromParts } from "@/lib/utils/file-token-utils";
import { truncateMessagesWithFileTokens } from "@/lib/utils/file-token-utils";
import type { SubscriptionTier } from "@/types";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

export async function getChatById({ id }: { id: string }) {
  try {
    const selectedChat = await convex.query(api.chats.getChatById, {
      serviceKey,
      id,
    });
    return selectedChat;
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveChat({
  id,
  userId,
  title,
}: {
  id: string;
  userId: string;
  title: string;
}) {
  try {
    return await convex.mutation(api.chats.saveChat, {
      serviceKey,
      id,
      userId,
      title,
    });
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}
export async function saveMessage({
  chatId,
  userId,
  message,
}: {
  chatId: string;
  userId: string;
  message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts: UIMessagePart<any, any>[];
  };
}) {
  try {
    // Extract file IDs from file parts
    const fileIds = extractFileIdsFromParts(message.parts);

    return await convex.mutation(api.messages.saveMessage, {
      serviceKey,
      id: message.id,
      chatId,
      userId,
      role: message.role,
      parts: message.parts,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
    });
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to save message");
  }
}

export async function handleInitialChatAndUserMessage({
  chatId,
  userId,
  messages,
  regenerate,
  chat,
}: {
  chatId: string;
  userId: string;
  messages: { id: string; parts: UIMessagePart<any, any>[] }[];
  regenerate?: boolean;
  chat: any; // Chat data from getMessagesByChatId
}) {
  if (!chat) {
    // Save new chat and get the document _id
    let title = "New Chat";

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (
        lastMessage?.parts &&
        Array.isArray(lastMessage.parts) &&
        lastMessage.parts.length > 0
      ) {
        const firstPart = lastMessage.parts[0];
        if (firstPart?.type === "text" && firstPart.text) {
          title = firstPart.text;
        }
      }
    }

    // Ensure title is a string and truncate safely
    title = (title ?? "New Chat").substring(0, 100);

    await saveChat({
      id: chatId,
      userId,
      title,
    });
  } else {
    // Check if user owns the chat
    if (chat.user_id !== userId) {
      throw new ChatSDKError(
        "forbidden:chat",
        "You don't have permission to access this chat",
      );
    }
  }

  // Only save user message if this is not a regeneration
  if (!regenerate) {
    await saveMessage({
      chatId,
      userId,
      message: {
        id: messages[messages.length - 1].id,
        role: "user",
        parts: messages[messages.length - 1].parts,
      },
    });
  }
}

export async function updateChat({
  chatId,
  title,
  finishReason,
  todos,
  defaultModelSlug,
}: {
  chatId: string;
  title?: string;
  finishReason?: string;
  todos?: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    sourceMessageId?: string;
  }>;
  defaultModelSlug?: "ask" | "agent";
}) {
  try {
    return await convex.mutation(api.chats.updateChat, {
      serviceKey,
      chatId,
      title,
      finishReason,
      todos,
      defaultModelSlug,
    });
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to update chat");
  }
}

export async function getMessagesByChatId({
  chatId,
  userId,
  newMessages,
  regenerate,
  subscription,
  isTemporary,
}: {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  newMessages: UIMessage[];
  regenerate?: boolean;
  isTemporary?: boolean;
}) {
  // For temporary chats, skip database operations
  let chat = undefined;
  let isNewChat = true;
  let existingMessages: UIMessage[] = [];

  if (!isTemporary) {
    // Check if chat exists first to avoid unnecessary Convex query
    chat = await getChatById({ id: chatId });
    isNewChat = !chat;

    // Only fetch existing messages if chat exists
    if (!isNewChat) {
      try {
        existingMessages = await convex.query(
          api.messages.getMessagesByChatIdForBackend,
          {
            serviceKey,
            chatId,
            userId,
          },
        );
      } catch (error) {
        // If error fetching, use empty array
        console.warn("Failed to fetch existing messages:", error);
      }
    }
  }

  // Handle message merging based on regeneration flag
  let allMessages: UIMessage[];

  if (regenerate && !isTemporary) {
    // For regeneration and not temporary chat, don't add new messages to avoid duplication
    // The backend query already excluded the last message being regenerated
    allMessages = existingMessages;
  } else {
    // For normal chat, merge existing messages with the new user message
    allMessages = [...existingMessages, ...newMessages];
  }

  // Truncate messages to stay within token limit with file tokens included
  const truncatedMessages = await truncateMessagesWithFileTokens(
    allMessages,
    subscription,
  );

  return { truncatedMessages, chat, isNewChat };
}

export async function getUserCustomization({ userId }: { userId: string }) {
  try {
    const userCustomization = await convex.query(
      api.userCustomization.getUserCustomizationForBackend,
      {
        serviceKey,
        userId,
      },
    );
    return userCustomization;
  } catch (error) {
    // If no customization found or error, return null
    return null;
  }
}

export async function getMemories({
  userId,
  subscription,
}: {
  userId: string;
  subscription: SubscriptionTier;
}) {
  try {
    const memories = await convex.query(api.memories.getMemoriesForBackend, {
      serviceKey,
      userId,
      subscription,
    });
    return memories;
  } catch (error) {
    // If no memories found or error, return empty array
    return [];
  }
}

// Generate a shorter memory ID (7 characters)
const generateMemoryId = () => {
  return Math.random().toString(36).substring(2, 9);
};

export async function getMemoryById({ memoryId }: { memoryId: string }) {
  try {
    const memory = await convex.query(api.memories.getMemoryByIdForBackend, {
      memoryId,
    });
    return memory;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to get memory",
    );
  }
}

export async function setActiveStreamId({
  chatId,
  activeStreamId,
}: {
  chatId: string;
  activeStreamId: string | undefined;
}) {
  try {
    await convex.mutation(api.chats.setActiveStreamId, {
      serviceKey,
      chatId,
      activeStreamId,
    });
    return;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to set active stream id",
    );
  }
}

export async function createMemory({
  userId,
  content,
  memoryId,
}: {
  userId: string;
  content: string;
  memoryId?: string;
}) {
  try {
    const finalMemoryId = memoryId || generateMemoryId();
    const returnedId = await convex.mutation(
      api.memories.createMemoryForBackend,
      {
        serviceKey,
        userId,
        memoryId: finalMemoryId,
        content: content.trim(),
      },
    );
    return returnedId;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to create memory",
    );
  }
}

export async function updateMemory({
  userId,
  memoryId,
  content,
}: {
  userId: string;
  memoryId: string;
  content: string;
}) {
  try {
    await convex.mutation(api.memories.updateMemoryForBackend, {
      serviceKey,
      userId,
      memoryId,
      content: content.trim(),
    });
    return;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to update memory",
    );
  }
}

export async function deleteMemory({
  userId,
  memoryId,
}: {
  userId: string;
  memoryId: string;
}) {
  try {
    await convex.mutation(api.memories.deleteMemoryForBackend, {
      serviceKey,
      userId,
      memoryId,
    });
    return;
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : "Failed to delete memory",
    );
  }
}
