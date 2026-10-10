const SOURCE_MESSAGE_HASH_KEY = "message";
const MAX_MESSAGE_ID_LENGTH = 128;

export function getSourceMessageHref(chatId: string, messageId: string) {
  return `/c/${encodeURIComponent(chatId)}#${SOURCE_MESSAGE_HASH_KEY}=${encodeURIComponent(messageId)}`;
}

export function getSourceMessageIdFromHash(hash: string) {
  const value = new URLSearchParams(
    hash.startsWith("#") ? hash.slice(1) : hash,
  ).get(SOURCE_MESSAGE_HASH_KEY);

  if (!value || value.length > MAX_MESSAGE_ID_LENGTH) return null;
  return value;
}

export function getChatMessageElementId(messageId: string) {
  return `chat-message-${encodeURIComponent(messageId)}`;
}
