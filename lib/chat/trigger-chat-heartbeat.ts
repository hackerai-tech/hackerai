export const TRIGGER_CHAT_HEARTBEAT_PART_TYPE = "data-agent-heartbeat" as const;

// Trigger.dev realtime stream subscriptions can go quiet while long terminal
// commands run. Keep a small, hidden UI-stream pulse comfortably below common
// idle cutoffs so later command output is still delivered to the frontend.
export const TRIGGER_CHAT_HEARTBEAT_INTERVAL_MS = 25_000;

type MessageWithParts = {
  parts?: unknown[];
};

const isTriggerChatHeartbeatPart = (part: unknown): boolean =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  (part as { type?: unknown }).type === TRIGGER_CHAT_HEARTBEAT_PART_TYPE;

export const stripTriggerChatHeartbeatParts = <T extends MessageWithParts>(
  message: T,
): T => {
  if (!Array.isArray(message.parts)) return message;

  const parts = message.parts.filter(
    (part) => !isTriggerChatHeartbeatPart(part),
  );
  if (parts.length === message.parts.length) return message;

  return { ...message, parts } as T;
};

export const stripTriggerChatHeartbeatPartsFromMessages = <
  T extends MessageWithParts,
>(
  messages: T[],
): T[] => {
  let changed = false;
  const stripped = messages.map((message) => {
    const next = stripTriggerChatHeartbeatParts(message);
    if (next !== message) changed = true;
    return next;
  });

  return changed ? stripped : messages;
};
