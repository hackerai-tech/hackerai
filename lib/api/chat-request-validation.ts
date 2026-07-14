import type { UIMessage } from "ai";
import { ChatSDKError } from "@/lib/errors";

const CHAT_MESSAGE_ROLES = new Set(["user", "assistant", "system"]);

const getValueKind = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidMessagesError = (
  field: string,
  value: unknown,
  reason?: string,
): ChatSDKError =>
  new ChatSDKError(
    "bad_request:api",
    "Invalid chat request: messages must be an array of UI messages.",
    {
      invalid_request_field: field,
      invalid_request_field_type: getValueKind(value),
      ...(reason ? { invalid_request_field_reason: reason } : {}),
      new_messages_count: 0,
    },
  );

export const requireBooleanFlag = (field: string, value: unknown): boolean => {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;

  throw new ChatSDKError(
    "bad_request:api",
    `Invalid chat request: ${field} must be a boolean.`,
    {
      invalid_request_field: field,
      invalid_request_field_type: getValueKind(value),
      invalid_request_field_reason: "not_boolean",
    },
  );
};

export const requireChatMessagesArray = (messages: unknown): UIMessage[] => {
  if (!Array.isArray(messages)) {
    throw invalidMessagesError("messages", messages, "not_array");
  }

  for (const [index, message] of messages.entries()) {
    const field = `messages[${index}]`;
    if (!isRecord(message)) {
      throw invalidMessagesError(field, message, "not_object");
    }

    if (typeof message.id !== "string" || message.id.length === 0) {
      throw invalidMessagesError(`${field}.id`, message.id, "invalid_id");
    }

    if (
      typeof message.role !== "string" ||
      !CHAT_MESSAGE_ROLES.has(message.role)
    ) {
      throw invalidMessagesError(`${field}.role`, message.role, "invalid_role");
    }

    if (!Array.isArray(message.parts)) {
      throw invalidMessagesError(`${field}.parts`, message.parts, "not_array");
    }

    for (const [partIndex, part] of message.parts.entries()) {
      const partField = `${field}.parts[${partIndex}]`;
      if (!isRecord(part)) {
        throw invalidMessagesError(partField, part, "not_object");
      }

      if (typeof part.type !== "string" || part.type.length === 0) {
        throw invalidMessagesError(
          `${partField}.type`,
          part.type,
          "invalid_type",
        );
      }

      if (
        (part.type === "text" || part.type === "reasoning") &&
        typeof part.text !== "string"
      ) {
        throw invalidMessagesError(
          `${partField}.text`,
          part.text,
          "invalid_text",
        );
      }
    }
  }

  return messages as UIMessage[];
};
