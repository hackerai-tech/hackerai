/**
 * Utility functions for processing message parts
 */

import type { ChatMessage, ChatMode } from "@/types";

export interface MessagePart {
  type: string;
  text?: string;
}

/**
 * Extracts text content from message parts
 */
export const extractMessageText = (parts: MessagePart[]): string => {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("");
};

/**
 * Checks if message parts contain any text content
 */
export const hasTextContent = (parts: MessagePart[]): boolean => {
  return parts.some(
    (part) =>
      (part.type === "text" && part.text && part.text.trim() !== "") ||
      part.type === "step-start" ||
      part.type.startsWith("tool-"),
  );
};

const MIN_CONTINUATION_OVERLAP_CHARS = 24;

const isTextPart = (
  part: ChatMessage["parts"][number],
): part is ChatMessage["parts"][number] & { type: "text"; text: string } =>
  part.type === "text" && typeof (part as { text?: unknown }).text === "string";

const isInsideMarkdownFence = (text: string): boolean => {
  const fences = text.match(/^[\t ]*```/gm);
  return (fences?.length ?? 0) % 2 === 1;
};

const stripRedundantOpeningFence = (
  previousText: string,
  continuationText: string,
): string => {
  if (!isInsideMarkdownFence(previousText)) return continuationText;

  // A bare fence closes the block left open by the previous segment. Only
  // remove a repeated opening fence when it carries an info string.
  return continuationText.replace(
    /^[\t ]*```[\t ]*[^\s`][^\n\r]*\r?\n/,
    "",
  );
};

const findExactSuffixPrefixOverlap = (
  previousText: string,
  continuationText: string,
): number => {
  if (
    previousText.length < MIN_CONTINUATION_OVERLAP_CHARS ||
    continuationText.length < MIN_CONTINUATION_OVERLAP_CHARS
  ) {
    return 0;
  }

  // KMP prefix table over `continuation + sentinel + previous` finds the
  // longest continuation prefix that is also a suffix of the previous text in
  // linear time. Use -1 as an out-of-band sentinel for UTF-16 code units.
  const previousSuffix = previousText.slice(-continuationText.length);
  const sequenceLength = continuationText.length + 1 + previousSuffix.length;
  const prefixLengths = new Uint32Array(sequenceLength);
  const codeUnitAt = (index: number): number => {
    if (index < continuationText.length) {
      return continuationText.charCodeAt(index);
    }
    if (index === continuationText.length) return -1;
    return previousSuffix.charCodeAt(index - continuationText.length - 1);
  };

  for (let index = 1; index < sequenceLength; index++) {
    let prefixLength = prefixLengths[index - 1];
    const codeUnit = codeUnitAt(index);
    while (prefixLength > 0 && codeUnit !== codeUnitAt(prefixLength)) {
      prefixLength = prefixLengths[prefixLength - 1];
    }
    if (codeUnit === codeUnitAt(prefixLength)) prefixLength += 1;
    prefixLengths[index] = prefixLength;
  }

  const overlap = prefixLengths[sequenceLength - 1];
  return overlap >= MIN_CONTINUATION_OVERLAP_CHARS ? overlap : 0;
};

/**
 * Joins a separately generated continuation to the previous text without
 * introducing a second Markdown/code block. Providers occasionally repeat the
 * tail of the first generation, so remove only a substantial exact overlap.
 */
export const joinContinuationText = (
  previousText: string,
  continuationText: string,
): string => {
  const strippedContinuation = stripRedundantOpeningFence(
    previousText,
    continuationText,
  );
  const overlap = findExactSuffixPrefixOverlap(
    previousText,
    strippedContinuation,
  );

  return previousText + strippedContinuation.slice(overlap);
};

const mergeContinuationParts = (
  previousParts: ChatMessage["parts"],
  continuationParts: ChatMessage["parts"],
): ChatMessage["parts"] => {
  const previousTextIndex = previousParts.findLastIndex(isTextPart);
  const continuationTextIndex = continuationParts.findIndex(isTextPart);

  if (previousTextIndex === -1 || continuationTextIndex === -1) {
    return [...previousParts, ...continuationParts];
  }

  const previousTextPart = previousParts[previousTextIndex];
  const continuationTextPart = continuationParts[continuationTextIndex];
  if (!isTextPart(previousTextPart) || !isTextPart(continuationTextPart)) {
    return [...previousParts, ...continuationParts];
  }

  return [
    ...previousParts.slice(0, previousTextIndex),
    ...continuationParts.slice(0, continuationTextIndex),
    {
      ...continuationTextPart,
      text: joinContinuationText(
        previousTextPart.text,
        continuationTextPart.text,
      ),
    },
    ...previousParts.slice(previousTextIndex + 1),
    ...continuationParts.slice(continuationTextIndex + 1),
  ];
};

const getMessageMode = (
  message: ChatMessage,
  fallbackMode?: ChatMode,
): ChatMode | undefined => message.metadata?.mode ?? fallbackMode;

/**
 * Projects stored generation segments into the user-visible conversation.
 * Ask-mode continuations remain separate records for usage, retry, and audit,
 * but render as one logical assistant response. Hidden continuation prompts are
 * removed here as before. Consecutive Ask assistant rows cover restored chats,
 * where Convex intentionally omits the hidden prompt from query results.
 */
export const mergeAskContinuationMessages = (
  messages: ChatMessage[],
  fallbackMode?: ChatMode,
): ChatMessage[] => {
  const visibleMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && message.metadata?.isAutoContinue) {
      continue;
    }

    const previousMessage = visibleMessages.at(-1);
    const isAskContinuation =
      message.role === "assistant" &&
      previousMessage?.role === "assistant" &&
      getMessageMode(message, fallbackMode) === "ask" &&
      getMessageMode(previousMessage, fallbackMode) === "ask";

    if (isAskContinuation && previousMessage) {
      visibleMessages[visibleMessages.length - 1] = {
        ...previousMessage,
        ...message,
        createdAt: previousMessage.createdAt ?? message.createdAt,
        sourceMessageId:
          message.sourceMessageId ?? previousMessage.sourceMessageId,
        parts: mergeContinuationParts(previousMessage.parts, message.parts),
        metadata: {
          ...previousMessage.metadata,
          ...message.metadata,
          createdAt:
            previousMessage.metadata?.createdAt ?? message.metadata?.createdAt,
          generationStartedAt:
            previousMessage.metadata?.generationStartedAt ??
            message.metadata?.generationStartedAt,
          generationTimeMs:
            previousMessage.metadata?.generationTimeMs === undefined &&
            message.metadata?.generationTimeMs === undefined
              ? undefined
              : (previousMessage.metadata?.generationTimeMs ?? 0) +
                (message.metadata?.generationTimeMs ?? 0),
          feedbackType:
            message.metadata?.feedbackType ??
            previousMessage.metadata?.feedbackType,
        },
        ...((previousMessage.fileDetails || message.fileDetails) && {
          fileDetails: [
            ...(previousMessage.fileDetails ?? []),
            ...(message.fileDetails ?? []),
          ],
        }),
      };
    } else {
      visibleMessages.push(message);
    }
  }

  return visibleMessages;
};

/**
 * Finds the index of the last assistant message
 */
export const findLastAssistantMessageIndex = (
  messages: Array<{ role: "user" | "assistant" | "system" }>,
): number | undefined => {
  return messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;
};

/**
 * Finds the last user-authored message, ignoring hidden auto-continue prompts.
 */
export const findLastUserMessageIndex = (
  messages: Array<{
    role: "user" | "assistant" | "system";
    metadata?: { isAutoContinue?: boolean };
  }>,
): number | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user" && !message.metadata?.isAutoContinue) {
      return index;
    }
  }

  return undefined;
};

/**
 * Represents a citation/source extracted from web tool outputs
 */
export type WebSource = {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
};

/**
 * Extract web sources from a message's tool outputs.
 * Handles both new `tool-web` and legacy `tool-web_search` parts
 * and flexible output shapes: array, { result: [] }, or { results: [] }.
 */
export const extractWebSourcesFromMessage = (message: {
  parts?: Array<any>;
}): Array<WebSource> => {
  const sources: Array<WebSource> = [];

  const parts: Array<any> = Array.isArray((message as any)?.parts)
    ? (message as any).parts
    : [];

  for (const part of parts) {
    if (part?.type === "tool-web" || part?.type === "tool-web_search") {
      if (part.state !== "output-available") continue;
      const output = part.output;

      let results: any = undefined;
      if (Array.isArray(output)) {
        results = output;
      } else if (Array.isArray(output?.result)) {
        results = output.result;
      } else if (Array.isArray(output?.results)) {
        results = output.results;
      }

      if (Array.isArray(results)) {
        for (const r of results) {
          const url = r?.url || r?.id;
          if (!url || typeof url !== "string") continue;
          sources.push({
            title: r?.title,
            url,
            text: r?.text,
            publishedDate: r?.publishedDate,
          });
        }
      }
    }
  }

  return sources;
};

/**
 * Collects assistant message IDs in the trailing auto-continue chain.
 * Walks backwards from the end of the messages array, collecting assistant IDs
 * until a real (non-auto-continue) user message is hit.
 */
export const getAutoContinueChainAssistantIds = (
  messages: Array<{
    id: string;
    role: string;
    metadata?: { isAutoContinue?: boolean };
  }>,
): string[] => {
  const chainAssistantIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      chainAssistantIds.push(msg.id);
    } else if (msg.role === "user" && msg.metadata?.isAutoContinue) {
      continue;
    } else {
      break;
    }
  }
  return chainAssistantIds;
};

/**
 * Finds the last real (non-auto-continue) user message and returns
 * messages up to and including it, discarding the trailing auto-continue chain.
 */
export const getMessagesUpToLastRealUser = <
  T extends { role: string; metadata?: { isAutoContinue?: boolean } },
>(
  messages: T[],
): T[] => {
  let lastRealUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !msg.metadata?.isAutoContinue) {
      lastRealUserIdx = i;
      break;
    }
  }
  return lastRealUserIdx >= 0 ? messages.slice(0, lastRealUserIdx + 1) : [];
};
