import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { ConvexHttpClient } from "convex/browser";
import { UIMessagePart } from "ai";

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
    return await convex.mutation(api.messages.saveMessage, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      id: message.id,
      chatId,
      role: message.role,
      parts: message.parts,
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
