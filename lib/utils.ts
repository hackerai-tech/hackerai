import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatSDKError, ErrorCode } from "./errors";
import { ChatMessage } from "@/types/chat";
import { UIMessagePart } from "ai";
import { Doc } from "@/convex/_generated/dataModel";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatSDKError(code as ErrorCode, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new ChatSDKError("offline:chat");
    }

    throw error;
  }
}

export function convertToUIMessages(
  messages: Doc<"messages">[],
): ChatMessage[] {
  return messages.map((message) => ({
    id: message._id,
    role: message.role as "user" | "assistant" | "system",
    parts: message.parts as UIMessagePart<any, any>[],
  }));
}
