import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatSDKError, ErrorCode } from "./errors";
import { ChatMessage, type ChatMode } from "@/types/chat";
import { UIMessagePart } from "ai";
import { Id } from "@/convex/_generated/dataModel";
import { stripOpenRouterReasoningMetadataFromParts } from "@/lib/chat/provider-metadata-sanitizer";

export interface MessageRecord {
  id: string;
  chat_id?: string;
  role: "user" | "assistant" | "system";
  parts: UIMessagePart<any, any>[];
  created_at?: number;
  source_message_id?: string;
  feedback?: {
    feedbackType: "positive" | "negative";
  } | null;
  mode?: ChatMode;
  generation_started_at?: number;
  generation_time_ms?: number;
  fileDetails?: Array<{
    fileId: Id<"files">;
    name: string;
    mediaType?: string;
    url?: string | null;
    s3Key?: string;
    sizeBytes?: number;
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
      const { code, cause, metadata } = await response.json();
      throw new ChatSDKError(code as ErrorCode, cause, metadata);
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
    ...(typeof message.created_at === "number"
      ? { createdAt: message.created_at }
      : {}),
    // Sanitize parts: remove any old URLs that may be stored in database
    // URLs expire, so we always fetch fresh ones via fileId
    parts: stripOpenRouterReasoningMetadataFromParts(message.parts).map(
      (part: any) => {
        if (part.type === "file" && part.url) {
          const { url, ...partWithoutUrl } = part;
          return partWithoutUrl;
        }
        return part;
      },
    ),
    sourceMessageId: message.source_message_id,
    metadata:
      message.feedback ||
      message.mode ||
      typeof message.generation_started_at === "number" ||
      typeof message.generation_time_ms === "number"
        ? {
            ...(message.feedback
              ? { feedbackType: message.feedback.feedbackType }
              : {}),
            ...(message.mode ? { mode: message.mode } : {}),
            ...(typeof message.generation_started_at === "number"
              ? { generationStartedAt: message.generation_started_at }
              : {}),
            ...(typeof message.generation_time_ms === "number"
              ? { generationTimeMs: message.generation_time_ms }
              : {}),
          }
        : undefined,
    fileDetails: message.fileDetails,
  }));
}
