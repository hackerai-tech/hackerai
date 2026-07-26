import type { ChatMessage } from "@/types";

type ReconciledMessage = Pick<ChatMessage, "id" | "role" | "parts">;

const haveSameJsonValue = (current: unknown, next: unknown): boolean => {
  if (Object.is(current, next)) return true;
  if (
    current === null ||
    next === null ||
    typeof current !== "object" ||
    typeof next !== "object"
  ) {
    return false;
  }

  const currentIsArray = Array.isArray(current);
  const nextIsArray = Array.isArray(next);
  if (currentIsArray !== nextIsArray) return false;

  if (currentIsArray && nextIsArray) {
    if (current.length !== next.length) return false;
    return current.every((value, index) =>
      haveSameJsonValue(value, next[index]),
    );
  }

  const currentRecord = current as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const currentKeys = Object.keys(currentRecord).filter(
    (key) => currentRecord[key] !== undefined,
  );
  const nextKeys = Object.keys(nextRecord).filter(
    (key) => nextRecord[key] !== undefined,
  );

  if (currentKeys.length !== nextKeys.length) return false;

  return currentKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(nextRecord, key) &&
      haveSameJsonValue(currentRecord[key], nextRecord[key]),
  );
};

export const areMessagesEquivalentForConvexSync = (
  current: readonly ReconciledMessage[],
  next: readonly ReconciledMessage[],
): boolean =>
  current.length === next.length &&
  current.every(
    (message, index) =>
      message.id === next[index].id &&
      message.role === next[index].role &&
      haveSameJsonValue(message.parts, next[index].parts),
  );
