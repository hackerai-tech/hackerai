import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { ConvexHttpClient } from "convex/browser";
import { UIMessagePart } from "ai";
import { UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Extract storage IDs from message parts
 * @param parts - Array of message parts
 * @returns Array of storage IDs found in file parts
 */
function extractStorageIdsFromParts(
  parts: UIMessagePart<any, any>[],
): string[] {
  const storageIds: string[] = [];

  for (const part of parts) {
    if (part.type === "file") {
      // Check if storageId exists directly
      if ((part as any).storageId) {
        storageIds.push((part as any).storageId);
      }
      // Also check url field as it might contain storageId (before transformation)
      else if ((part as any).url && typeof (part as any).url === "string") {
        // Assume url contains storageId if it doesn't start with http
        const url = (part as any).url;
        if (!url.startsWith("http")) {
          storageIds.push(url);
        }
      }
    }
  }

  return storageIds;
}

export async function getChatById({ id }: { id: string }) {
  try {
    const selectedChat = await convex.query(api.chats.getChatById, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
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
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
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
  message,
}: {
  chatId: string;
  message: {
    id: string;
    role: string;
    parts: UIMessagePart<any, any>[];
  };
}) {
  try {
    // Extract storage IDs from file parts
    const storageIds = extractStorageIdsFromParts(message.parts);

    return await convex.mutation(api.messages.saveMessage, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      id: message.id,
      chatId,
      role: message.role,
      parts: message.parts,
      storageIds:
        storageIds.length > 0 ? (storageIds as Id<"_storage">[]) : undefined,
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
}: {
  chatId: string;
  userId: string;
  messages: { id: string; parts: UIMessagePart<any, any>[] }[];
  regenerate?: boolean;
}): Promise<{ isNewChat: boolean }> {
  const chat = await getChatById({ id: chatId });
  const isNewChat = !chat;

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
      userId: userId,
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
      message: {
        id: messages[messages.length - 1].id,
        role: "user",
        parts: messages[messages.length - 1].parts,
      },
    });
  }

  return { isNewChat };
}

export async function updateChat({
  chatId,
  title,
  finishReason,
  todos,
}: {
  chatId: string;
  title?: string;
  finishReason?: string;
  todos?: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
}) {
  try {
    return await convex.mutation(api.chats.updateChat, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      chatId,
      title,
      finishReason,
      todos,
    });
  } catch (error) {
    throw new ChatSDKError("bad_request:database", "Failed to update chat");
  }
}

/**
 * Transforms storageIds to URLs in file parts of messages
 * @param messages - Array of messages to process
 */
export async function transformStorageIdsToUrls(
  messages: UIMessage[],
): Promise<UIMessage[]> {
  // Create a deep copy of messages to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];

  // Collect all storageIds that need URL fetching
  const storageIdsToFetch: string[] = [];
  const storageIdToFilePartMap = new Map<
    string,
    Array<{ messageIndex: number; partIndex: number }>
  >();

  for (
    let messageIndex = 0;
    messageIndex < updatedMessages.length;
    messageIndex++
  ) {
    const message = updatedMessages[messageIndex];
    if (!message.parts) continue;

    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex] as any;

      if (part.type === "file") {
        // Always remove storageId at the end
        const cleanupFilePart = () => {
          if (part.storageId) {
            delete part.storageId;
          }
        };

        // If already has HTTP URL, just cleanup and continue
        if (part.url && part.url.startsWith("http")) {
          cleanupFilePart();
          continue;
        }

        // Extract storageId that needs URL fetching
        const storageId = part.storageId || part.url;
        if (storageId && !storageId.startsWith("http")) {
          if (!storageIdToFilePartMap.has(storageId)) {
            storageIdsToFetch.push(storageId);
            storageIdToFilePartMap.set(storageId, []);
          }
          storageIdToFilePartMap
            .get(storageId)!
            .push({ messageIndex, partIndex });
        }
      }
    }
  }

  // If no URLs to fetch, return updated messages (storageIds already cleaned up)
  if (storageIdsToFetch.length === 0) {
    return updatedMessages;
  }

  try {
    // Fetch URLs for storageIds
    const urls = await convex.query(api.fileStorage.getFileUrlsWithServiceKey, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      storageIds: storageIdsToFetch as Id<"_storage">[],
    });

    // Update file parts with fetched URLs and remove storageIds
    for (let i = 0; i < storageIdsToFetch.length; i++) {
      const storageId = storageIdsToFetch[i];
      const url = urls[i];
      const filePartPositions = storageIdToFilePartMap.get(storageId);

      if (url && filePartPositions) {
        for (const { messageIndex, partIndex } of filePartPositions) {
          const filePart = updatedMessages[messageIndex].parts![
            partIndex
          ] as any;
          if (filePart.type === "file") {
            filePart.url = url;
            delete filePart.storageId; // Remove storageId after setting URL
          }
        }
      }
    }

    return updatedMessages;
  } catch (error) {
    console.error("Failed to transform storageIds to URLs:", error);
    // Return original messages if transformation fails
    return messages;
  }
}
