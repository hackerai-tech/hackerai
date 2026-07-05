type MessagePartLike = {
  type?: unknown;
  text?: unknown;
};

type RetryDecisionOptions = {
  hasTerminalProviderStreamError: boolean;
  stoppedDueToDoomLoop?: boolean;
  stoppedDueToAssistantContentLoop?: boolean;
  detectAssistantContentLoop?: boolean;
};

export type AssistantContentLoopDetection = {
  detected: boolean;
  reason?: "repeated_text";
  repeatedText?: string;
  repeatCount?: number;
};

const FALLBACK_SAFE_METADATA_PART_TYPES = new Set([
  "data-agent-heartbeat",
  "data-context-usage",
]);

const NO_ASSISTANT_CONTENT_LOOP: AssistantContentLoopDetection = {
  detected: false,
};

const MIN_ASSISTANT_LOOP_CHARS = 120;
const MIN_ASSISTANT_LOOP_TOKENS = 24;
const MIN_REPEATED_PHRASE_TOKENS = 3;
const MAX_REPEATED_PHRASE_TOKENS = 16;
const MIN_REPEATED_PHRASE_CHARS = 18;
const MIN_REPEATED_PHRASE_COUNT = 4;
const MAX_LOOP_MONITOR_CHARS = 6000;
const LOOP_MONITOR_CHECK_INTERVAL_CHARS = 48;

const getPartType = (part: unknown): string | undefined => {
  if (!part || typeof part !== "object") return undefined;
  const type = (part as MessagePartLike).type;
  return typeof type === "string" ? type : undefined;
};

const getPartText = (part: unknown): string | undefined => {
  if (!part || typeof part !== "object") return undefined;
  const text = (part as MessagePartLike).text;
  return typeof text === "string" ? text : undefined;
};

const isOnlyStepStart = (parts: unknown[]): boolean =>
  parts.length === 1 && getPartType(parts[0]) === "step-start";

const isFallbackSafeProviderPart = (part: unknown): boolean => {
  const type = getPartType(part);
  return (
    type === "step-start" ||
    type === "reasoning" ||
    (type != null && FALLBACK_SAFE_METADATA_PART_TYPES.has(type))
  );
};

const hasReasoningPart = (parts: unknown[]): boolean =>
  parts.some((part) => getPartType(part) === "reasoning");

const isReasoningOnlyProviderOutput = (parts: unknown[]): boolean =>
  parts.length > 0 &&
  hasReasoningPart(parts) &&
  parts.every(isFallbackSafeProviderPart);

const stripFencedCodeBlocks = (text: string): string =>
  text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ");

const normalizeAssistantLoopText = (text: string): string =>
  stripFencedCodeBlocks(text)
    .toLowerCase()
    .replace(/\[[^\]]*tool[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenizeAssistantLoopText = (text: string): string[] =>
  normalizeAssistantLoopText(text).match(/[a-z0-9_./:-]+/g) ?? [];

const tokenSliceEquals = (
  tokens: string[],
  leftStart: number,
  rightStart: number,
  length: number,
): boolean => {
  for (let offset = 0; offset < length; offset++) {
    if (tokens[leftStart + offset] !== tokens[rightStart + offset]) {
      return false;
    }
  }
  return true;
};

export const detectAssistantContentLoopFromText = (
  text: string,
): AssistantContentLoopDetection => {
  const normalized = normalizeAssistantLoopText(text);
  if (normalized.length < MIN_ASSISTANT_LOOP_CHARS) {
    return NO_ASSISTANT_CONTENT_LOOP;
  }

  const tokens = tokenizeAssistantLoopText(normalized);
  if (tokens.length < MIN_ASSISTANT_LOOP_TOKENS) {
    return NO_ASSISTANT_CONTENT_LOOP;
  }

  for (
    let phraseLength = MIN_REPEATED_PHRASE_TOKENS;
    phraseLength <= MAX_REPEATED_PHRASE_TOKENS;
    phraseLength++
  ) {
    for (let start = 0; start + phraseLength * 2 <= tokens.length; start++) {
      if (
        !tokenSliceEquals(tokens, start, start + phraseLength, phraseLength)
      ) {
        continue;
      }

      let repeatCount = 2;
      let nextStart = start + phraseLength * 2;
      while (
        nextStart + phraseLength <= tokens.length &&
        tokenSliceEquals(tokens, start, nextStart, phraseLength)
      ) {
        repeatCount++;
        nextStart += phraseLength;
      }

      const repeatedText = tokens.slice(start, start + phraseLength).join(" ");
      if (
        repeatCount >= MIN_REPEATED_PHRASE_COUNT &&
        repeatedText.length >= MIN_REPEATED_PHRASE_CHARS
      ) {
        return {
          detected: true,
          reason: "repeated_text",
          repeatedText,
          repeatCount,
        };
      }
    }
  }

  return NO_ASSISTANT_CONTENT_LOOP;
};

export const detectAssistantContentLoopFromParts = (
  parts: unknown[],
): AssistantContentLoopDetection => {
  const text = parts.map(getPartText).filter(Boolean).join(" ");
  if (!text.trim()) return NO_ASSISTANT_CONTENT_LOOP;
  return detectAssistantContentLoopFromText(text);
};

export const createAssistantContentLoopMonitor = () => {
  let buffer = "";
  let charsSinceCheck = 0;

  return {
    appendDelta(delta: string): AssistantContentLoopDetection {
      if (!delta) return NO_ASSISTANT_CONTENT_LOOP;

      buffer = (buffer + delta).slice(-MAX_LOOP_MONITOR_CHARS);
      charsSinceCheck += delta.length;

      if (
        buffer.length < MIN_ASSISTANT_LOOP_CHARS ||
        charsSinceCheck < LOOP_MONITOR_CHECK_INTERVAL_CHARS
      ) {
        return NO_ASSISTANT_CONTENT_LOOP;
      }

      charsSinceCheck = 0;
      return detectAssistantContentLoopFromText(buffer);
    },
  };
};

export const shouldRetryProviderStreamWithFallback = (
  parts: unknown[],
  options: RetryDecisionOptions,
): boolean => {
  // Preserve the older guard for streams that never got past the first step.
  if (isOnlyStepStart(parts)) return true;

  if (
    options.stoppedDueToDoomLoop ||
    options.stoppedDueToAssistantContentLoop
  ) {
    return true;
  }

  if (
    (options.detectAssistantContentLoop ?? true) &&
    detectAssistantContentLoopFromParts(parts).detected
  ) {
    return true;
  }

  // If the provider stream dies after emitting only reasoning/metadata, there
  // is no text, tool call, or tool output to preserve. Retrying on fallback is
  // safer than failing the whole run on a discarded provider socket.
  return (
    options.hasTerminalProviderStreamError &&
    isReasoningOnlyProviderOutput(parts)
  );
};

export const shouldRetryAgentLongWithFallback =
  shouldRetryProviderStreamWithFallback;
