import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatSDKError, ErrorCode } from "./errors";
import { ChatMessage } from "@/types/chat";
import { UIMessagePart } from "ai";
import { Id } from "@/convex/_generated/dataModel";

export interface MessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIMessagePart<any, any>[];
  feedback?: {
    feedbackType: "positive" | "negative";
  } | null;
  fileDetails?: Array<{
    fileId: Id<"files">;
    name: string;
    url: string | null;
  }>;
}

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

export function convertToUIMessages(messages: MessageRecord[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: message.feedback
      ? { feedbackType: message.feedback.feedbackType }
      : undefined,
    fileDetails: message.fileDetails,
  }));
}
