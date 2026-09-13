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

const partStateProgress: Record<string, number> = {
  streaming: 0,
  done: 1,
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "approval-responded": 3,
  "output-available": 4,
  "output-error": 4,
  "output-denied": 4,
};

const isPersistedPartAtLeastAsComplete = (
  current: ChatMessage["parts"][number],
  persisted: ChatMessage["parts"][number],
): boolean => {
  const currentPart = current as Record<string, unknown>;
  const persistedPart = persisted as Record<string, unknown>;

  if (currentPart.type !== persistedPart.type) return false;
  if (
    typeof currentPart.toolCallId === "string" &&
    currentPart.toolCallId !== persistedPart.toolCallId
  ) {
    return false;
  }

  for (const field of ["text", "delta"] as const) {
    const currentText = currentPart[field];
    if (typeof currentText !== "string") continue;
    const persistedText = persistedPart[field];
    if (
      typeof persistedText !== "string" ||
      !persistedText.startsWith(currentText)
    ) {
      return false;
    }
  }

  const currentState = currentPart.state;
  if (typeof currentState === "string") {
    const persistedState = persistedPart.state;
    if (typeof persistedState !== "string") return false;

    const currentProgress = partStateProgress[currentState];
    const persistedProgress = partStateProgress[persistedState];
    if (
      currentProgress === undefined || persistedProgress === undefined
        ? currentState !== persistedState
        : persistedProgress < currentProgress
    ) {
      return false;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(currentPart, "output") &&
    !Object.prototype.hasOwnProperty.call(persistedPart, "output")
  ) {
    return false;
  }

  return true;
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

export const arePersistedMessagesAtLeastAsComplete = (
  current: readonly ReconciledMessage[],
  persisted: readonly ReconciledMessage[],
): boolean => {
  const persistedById = new Map(
    persisted.map((message) => [message.id, message]),
  );

  return current.every((message) => {
    const persistedMessage = persistedById.get(message.id);
    if (!persistedMessage || persistedMessage.role !== message.role) {
      return false;
    }
    if (persistedMessage.parts.length < message.parts.length) return false;

    return message.parts.every((part, index) =>
      isPersistedPartAtLeastAsComplete(part, persistedMessage.parts[index]),
    );
  });
};
