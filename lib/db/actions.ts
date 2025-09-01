import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { ConvexHttpClient } from "convex/browser";
import { UIMessagePart } from "ai";
import { UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";
import { extractFileIdsFromParts } from "@/lib/utils/file-token-utils";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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
    // Extract file IDs from file parts
    const fileIds = extractFileIdsFromParts(message.parts);

    return await convex.mutation(api.messages.saveMessage, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      id: message.id,
      chatId,
      role: message.role,
      parts: message.parts,
      fileIds: fileIds.length > 0 ? (fileIds as Id<"files">[]) : undefined,
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
 * Transforms fileIds to URLs in file parts of messages
 * @param messages - Array of messages to process
 */
export async function transformStorageIdsToUrls(
  messages: UIMessage[],
): Promise<UIMessage[]> {
  // Create a deep copy of messages to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];

  // Collect all fileIds that need URL fetching
  const fileIdsToFetch: string[] = [];
  const fileIdToFilePartMap = new Map<
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
        // If already has HTTP URL, continue
        if (part.url && part.url.startsWith("http")) {
          continue;
        }

        // Extract fileId that needs URL fetching
        const fileId = part.fileId;
        if (fileId) {
          if (!fileIdToFilePartMap.has(fileId)) {
            fileIdsToFetch.push(fileId);
            fileIdToFilePartMap.set(fileId, []);
          }
          fileIdToFilePartMap.get(fileId)!.push({ messageIndex, partIndex });
        }
      }
    }
  }

  // If no URLs to fetch, return updated messages
  if (fileIdsToFetch.length === 0) {
    return updatedMessages;
  }

  try {
    // Fetch URLs for fileIds
    const urls = await convex.query(api.fileStorage.getFileUrlsByFileIds, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      fileIds: fileIdsToFetch as Id<"files">[],
    });

    // Update file parts with fetched URLs
    for (let i = 0; i < fileIdsToFetch.length; i++) {
      const fileId = fileIdsToFetch[i];
      const url = urls[i];
      const filePartPositions = fileIdToFilePartMap.get(fileId);

      if (url && filePartPositions) {
        for (const { messageIndex, partIndex } of filePartPositions) {
          const filePart = updatedMessages[messageIndex].parts![
            partIndex
          ] as any;
          if (filePart.type === "file") {
            filePart.url = url;
          }
        }
      }
    }

    return updatedMessages;
  } catch (error) {
    console.error("Failed to transform fileIds to URLs:", error);
    // Return original messages if transformation fails
    return messages;
  }
}

/**
 * Fetch file content for non-media files and create document text parts
 * @param fileIds - Array of file IDs to fetch content for
 * @returns Object with formatted document content string and array of file IDs that have content
 */
export async function getDocumentContentForFiles(
  fileIds: string[],
): Promise<{ documentContent: string; fileIdsWithContent: string[] }> {
  if (fileIds.length === 0) {
    return { documentContent: "", fileIdsWithContent: [] };
  }

  try {
    // Fetch file content and metadata
    const fileContents = await convex.query(api.fileStorage.getFileContentByFileIds, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      fileIds: fileIds as Id<"files">[],
    });

    // Filter files that have content (non-image, non-PDF files)
    const documentsWithContent = fileContents.filter(file => file.content !== null);

    if (documentsWithContent.length === 0) {
      return { documentContent: "", fileIdsWithContent: [] };
    }

    // Format documents according to the specified format
    const documents = documentsWithContent
      .map((file) => {
        return `<document id="${file.id}">
<source>${file.name}</source>
<document_content>${file.content}</document_content>
</document>`;
      })
      .join('\n\n');

    const documentContent = `<documents>\n${documents}\n</documents>`;
    const fileIdsWithContent = documentsWithContent.map(file => file.id);

    return { documentContent, fileIdsWithContent };
  } catch (error) {
    console.error("Failed to fetch file content:", error);
    return { documentContent: "", fileIdsWithContent: [] };
  }
}
