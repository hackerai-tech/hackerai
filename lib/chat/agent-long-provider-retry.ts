import { hasMeaningfulToolInput } from "@/lib/chat/tool-abort-utils";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import { getSummarizationThresholdTokens } from "@/lib/chat/summarization/constants";
import { getAgentContextBudget } from "@/lib/ai/agent-context-budget";
import type { SubscriptionTier } from "@/types";
import { OUTPUT_LIMIT_FINISH_REASON } from "@/lib/chat/stop-conditions";
import {
  isStaticToolUIPart,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";

type MessagePartLike = {
  type?: unknown;
  text?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  errorText?: unknown;
};

type RetryDecisionOptions = {
  hasTerminalProviderStreamError: boolean;
  finishReason?: string;
  providerContentBlocked?: boolean;
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

const INTERRUPTED_TOOL_INPUT_SAFE_PART_TYPES = new Set([
  "step-start",
  "reasoning",
  "text",
  ...FALLBACK_SAFE_METADATA_PART_TYPES,
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

const getPartState = (part: unknown): string | undefined => {
  if (!part || typeof part !== "object") return undefined;
  const state = (part as MessagePartLike).state;
  return typeof state === "string" ? state : undefined;
};

const isToolPart = (part: unknown): boolean =>
  getPartType(part)?.startsWith("tool-") ?? false;

const hasToolOutputOrError = (part: unknown): boolean => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as MessagePartLike;
  return (
    candidate.output != null ||
    candidate.result != null ||
    candidate.errorText != null ||
    candidate.state === "output-available" ||
    candidate.state === "output-error"
  );
};

const isCompletedToolPart = (part: unknown): boolean =>
  isToolPart(part) && hasToolOutputOrError(part);

const hasDurableAssistantPart = (parts: unknown[]): boolean =>
  parts.some((part) => {
    const type = getPartType(part);
    if (type === "text") return Boolean(getPartText(part)?.trim());
    return isCompletedToolPart(part);
  });

export const getProviderOutputDiagnostics = (parts: unknown[]) => ({
  part_count: parts.length,
  completed_tool_count: parts.filter(isCompletedToolPart).length,
  has_durable_output: hasDurableAssistantPart(parts),
  has_step_boundary: parts.some((part) => getPartType(part) === "step-start"),
});

/** Shared eligibility and skip reason so telemetry cannot drift from behavior. */
export function decideProviderRecovery(options: {
  userCancelled: boolean;
  unrecoverableVision: boolean;
  alreadyRetried: boolean;
  streamAborted: boolean;
  loopRecovery: boolean;
  hasCandidate: boolean;
  modelEligible: boolean;
}) {
  const reason = options.userCancelled
    ? "user_cancelled"
    : options.unrecoverableVision
      ? "vision_recovery_unavailable"
      : options.alreadyRetried
        ? "retry_budget_exhausted"
        : options.streamAborted && !options.loopRecovery
          ? "stream_aborted"
          : !options.hasCandidate
            ? "no_safe_recovery"
            : !options.modelEligible
              ? "model_not_eligible"
              : "eligible";
  return { attempt: reason === "eligible", reason };
}

export type ProviderDisconnectContinuation = {
  messages: UIMessage[];
  removedPartCount: number;
  preservedCompletedToolCount: number;
  preservedUnknownToolCount: number;
  preservedTextPartCount: number;
};

export type ProviderDisconnectContinuationRejection =
  "missing_assistant" | "missing_step_boundary";

const DEEPSEEK_PRO_MODEL = "model-deepseek-v4-pro-0813";
const DEEPSEEK_PRO_RECOVERY_CHAIN = ["model-glm-5.3", "model-kimi-k3"] as const;

/**
 * Return the next bounded app-side recovery after a stream disconnect.
 * Max uses DeepSeek 1017 then a context-checked Grok attempt. Existing Pro
 * recovery remains DeepSeek Pro -> GLM -> Kimi. Counts are attempts started.
 */
export const getNextProviderDisconnectRetryModel = ({
  originalModel,
  failedModel,
  completedRetryCount,
  selectedModelOverride,
  agentModelContextEnabled,
  subscription,
  requiredContextTokens,
}: {
  originalModel: string;
  failedModel: string;
  completedRetryCount: number;
  selectedModelOverride?: string;
  agentModelContextEnabled?: boolean;
  subscription?: SubscriptionTier;
  requiredContextTokens?: number;
}):
  | (typeof DEEPSEEK_PRO_RECOVERY_CHAIN)[number]
  | "model-grok-4.6"
  | undefined => {
  if (selectedModelOverride === "hackerai-max") {
    if (
      completedRetryCount !== 1 ||
      failedModel !== DEEPSEEK_1017_MODEL_KEY ||
      requiredContextTokens === undefined ||
      !Number.isFinite(requiredContextTokens) ||
      requiredContextTokens < 0
    )
      return;
    const grokBudget = getAgentContextBudget({
      enabled: agentModelContextEnabled,
      mode: "agent",
      subscription,
      modelId: "x-ai/grok-4.6",
    });
    return requiredContextTokens <= getSummarizationThresholdTokens(grokBudget)
      ? "model-grok-4.6"
      : undefined;
  }
  if (originalModel !== DEEPSEEK_PRO_MODEL) return undefined;

  if (completedRetryCount === 0 && failedModel === DEEPSEEK_PRO_MODEL) {
    return DEEPSEEK_PRO_RECOVERY_CHAIN[0];
  }

  if (
    completedRetryCount === 1 &&
    failedModel === DEEPSEEK_PRO_RECOVERY_CHAIN[0]
  ) {
    return DEEPSEEK_PRO_RECOVERY_CHAIN[1];
  }

  return undefined;
};

/**
 * Build a replay-safe transcript after a provider socket dies mid-step.
 *
 * AI SDK agent output uses `step-start` boundaries. Everything before the
 * final boundary belongs to completed model/tool steps and is safe to retain.
 * The final step is incomplete even when the provider adapter closes its text
 * part during error cleanup, so it must not be treated as durable. A completed
 * tool result is the exception: preserve it and trim only the tail after it so
 * a continuation cannot repeat an already-executed side effect.
 */
export const prepareProviderDisconnectContinuation = (
  messages: UIMessage[],
  {
    allowEmptyResponse = false,
    onRejected,
  }: {
    allowEmptyResponse?: boolean;
    onRejected?: (reason: ProviderDisconnectContinuationRejection) => void;
  } = {},
): ProviderDisconnectContinuation | undefined => {
  const reject = (reason: ProviderDisconnectContinuationRejection) => {
    try {
      onRejected?.(reason);
    } catch {
      // Diagnostics cannot change the existing recovery decision.
    }
    return undefined;
  };
  const assistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  if (assistantIndex < 0) {
    // A pre-stream failure with no output cannot have started an app tool.
    if (allowEmptyResponse && messages.length === 0)
      return {
        messages: [],
        removedPartCount: 0,
        preservedCompletedToolCount: 0,
        preservedUnknownToolCount: 0,
        preservedTextPartCount: 0,
      };
    return reject("missing_assistant");
  }

  const assistant = messages[assistantIndex];
  const parts = assistant.parts ?? [];
  const lastStepStartIndex = parts.findLastIndex(
    (part) => getPartType(part) === "step-start",
  );
  if (lastStepStartIndex < 0) return reject("missing_step_boundary");

  const lastCompletedToolIndex = parts.findLastIndex(isCompletedToolPart);
  const preserveUntil = Math.max(
    lastStepStartIndex,
    lastCompletedToolIndex >= lastStepStartIndex
      ? lastCompletedToolIndex + 1
      : lastStepStartIndex,
  );
  const removedPartCount = parts.length - preserveUntil;
  // A completed tool can be the last part when the next provider request fails
  // before emitting a new step. Its result is durable even with no tail to trim.

  const preservedParts = parts.slice(0, preserveUntil);
  let preservedUnknownToolCount = 0;
  // Parallel tools can leave an unfinished call before a completed sibling.
  // Keep its identity with an explicit unknown outcome: dropping it loses the
  // execution record, while retaining input-available breaks the next request.
  const continuationParts = preservedParts.map((part) => {
    if (
      !isStaticToolUIPart(part) ||
      part.state !== "input-available" ||
      part.providerExecuted === true
    )
      return part;
    preservedUnknownToolCount++;
    return {
      ...part,
      state: "output-error" as const,
      errorText:
        "The provider stream ended before this tool's result was received; its execution outcome is unknown. Verify its effects before considering another execution.",
    };
  });
  const normalizedMessages = messages.slice(0, assistantIndex);
  if (hasDurableAssistantPart(continuationParts)) {
    normalizedMessages.push({ ...assistant, parts: continuationParts });
  }
  normalizedMessages.push(...messages.slice(assistantIndex + 1));

  return {
    messages: normalizedMessages,
    removedPartCount,
    preservedCompletedToolCount:
      preservedParts.filter(isCompletedToolPart).length,
    preservedUnknownToolCount,
    preservedTextPartCount: preservedParts.filter(
      (part) =>
        getPartType(part) === "text" && Boolean(getPartText(part)?.trim()),
    ).length,
  };
};

const isRestartableInterruptedToolInput = (part: unknown): boolean => {
  if (!isToolPart(part) || !part || typeof part !== "object") return false;
  const candidate = part as MessagePartLike;
  return (
    getPartState(part) === "input-streaming" &&
    !hasToolOutputOrError(part) &&
    hasMeaningfulToolInput(candidate.input)
  );
};

const isSafeInterruptedToolInputPart = (part: unknown): boolean => {
  const type = getPartType(part);
  if (!type) return false;
  return (
    INTERRUPTED_TOOL_INPUT_SAFE_PART_TYPES.has(type) ||
    isRestartableInterruptedToolInput(part)
  );
};

const isOnlyStepStart = (parts: unknown[]): boolean =>
  parts.length === 1 && getPartType(parts[0]) === "step-start";

const isFallbackSafeProviderPart = (part: unknown): boolean => {
  const type = getPartType(part);
  return (
    type === "step-start" ||
    type === "reasoning" ||
    (type === "text" && !getPartText(part)?.trim()) ||
    (type != null && FALLBACK_SAFE_METADATA_PART_TYPES.has(type))
  );
};

/** A normal stop with only hidden output or tool activity is not an answer. */
export const isTerminalEmptyAssistantResponse = (
  parts: unknown[],
  finishReason?: string,
): boolean =>
  finishReason === "stop" &&
  parts.every((part) => isFallbackSafeProviderPart(part) || isToolPart(part));

/** Unknown tool outcomes require user review before any model continuation. */
export const hasUncertainProviderToolOutcome = (parts: unknown[]): boolean =>
  parts.some((part) => isToolPart(part) && !isCompletedToolPart(part));

export const PROVIDER_EMPTY_RESPONSE_MESSAGE =
  "The model finished without a usable answer. Any completed tool results remain in this chat, but I could not safely finish the response. Continue this chat to review the work before repeating any action.";
const UNKNOWN_PROVIDER_TOOL_OUTCOME_MESSAGE =
  "The model stopped before this tool's result was confirmed. Its outcome is unknown; review its effects before trying it again.";

/** Add the failure to both live UI output and the message later persisted. */
export const appendProviderEmptyResponseFailure = (
  messages: UIMessage[],
  messageId: string,
  writer: UIMessageStreamWriter,
): void => {
  const assistant = messages.findLast(
    (message) => message.role === "assistant",
  );
  const failurePart = {
    type: "text" as const,
    text: PROVIDER_EMPTY_RESPONSE_MESSAGE,
    state: "done" as const,
  };
  if (assistant) {
    assistant.parts = [
      ...assistant.parts.map((part) => {
        if (!isStaticToolUIPart(part) || part.state !== "input-available")
          return part;
        writer.write({
          type: "tool-output-error",
          toolCallId: part.toolCallId,
          errorText: UNKNOWN_PROVIDER_TOOL_OUTCOME_MESSAGE,
          providerExecuted: part.providerExecuted,
        });
        return {
          ...part,
          state: "output-error" as const,
          errorText: UNKNOWN_PROVIDER_TOOL_OUTCOME_MESSAGE,
        };
      }),
      failurePart,
    ];
  } else {
    messages.push({ id: messageId, role: "assistant", parts: [failurePart] });
  }
  const textId = `provider-empty-${messageId}`;
  writer.write({ type: "text-start", id: textId });
  writer.write({ type: "text-delta", id: textId, delta: failurePart.text });
  writer.write({ type: "text-end", id: textId });
};

const hasReasoningPart = (parts: unknown[]): boolean =>
  parts.some((part) => getPartType(part) === "reasoning");

const isReasoningOnlyProviderOutput = (parts: unknown[]): boolean =>
  parts.length > 0 &&
  hasReasoningPart(parts) &&
  parts.every(isFallbackSafeProviderPart);

const isOutputLimitWithoutDurableOutput = (parts: unknown[]): boolean =>
  parts.every(isFallbackSafeProviderPart);

const isInterruptedToolInputOnlyProviderOutput = (parts: unknown[]): boolean =>
  parts.length > 0 &&
  parts.some(isRestartableInterruptedToolInput) &&
  parts.every(isSafeInterruptedToolInputPart);

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

export const shouldRetryProviderStreamAfterReasoningOnlyOutput = (
  parts: unknown[],
  options: Pick<RetryDecisionOptions, "hasTerminalProviderStreamError">,
): boolean =>
  options.hasTerminalProviderStreamError &&
  isReasoningOnlyProviderOutput(parts);

export const shouldRetryProviderStreamAfterNonDurableOutputLimit = (
  parts: unknown[],
  options: Pick<RetryDecisionOptions, "finishReason">,
): boolean =>
  options.finishReason === OUTPUT_LIMIT_FINISH_REASON &&
  isOutputLimitWithoutDurableOutput(parts);

export const shouldRetryProviderStreamWithFallback = (
  parts: unknown[],
  options: RetryDecisionOptions,
): boolean => {
  // Provider content filters are model-specific. Retry the run once with the
  // configured fallback model; the caller's bounded retry guard keeps a second
  // content-filter finish terminal.
  if (options.providerContentBlocked) return true;

  // An HTTP rejection can arrive via streamText.onError without emitting a
  // step-start. Metadata/empty text is also non-durable and safe to retry.
  if (
    options.hasTerminalProviderStreamError &&
    parts.every(isFallbackSafeProviderPart)
  )
    return true;

  // A provider can consume the entire output allowance as hidden reasoning
  // and return no text or completed tool call. Treat that as a failed model
  // leg so Auto can make one bounded fallback attempt instead of persisting a
  // successful-looking empty response. Output-bearing turns are deliberately
  // excluded: their text and completed tool effects must be saved, and the
  // existing bounded continuation keeps the user's selected model.
  if (shouldRetryProviderStreamAfterNonDurableOutputLimit(parts, options)) {
    return true;
  }

  // The provider can finish normally after spending its output on hidden
  // reasoning. Retry only when there are no tool effects to replay.
  if (
    isTerminalEmptyAssistantResponse(parts, options.finishReason) &&
    parts.every(isFallbackSafeProviderPart)
  ) {
    return true;
  }

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
    shouldRetryProviderStreamAfterReasoningOnlyOutput(parts, options) ||
    (options.hasTerminalProviderStreamError &&
      isInterruptedToolInputOnlyProviderOutput(parts))
  );
};

export const shouldRetryAgentLongWithFallback =
  shouldRetryProviderStreamWithFallback;

export const shouldRetryProviderStreamAfterInterruptedToolInput = (
  parts: unknown[],
  options: Pick<RetryDecisionOptions, "hasTerminalProviderStreamError">,
): boolean =>
  options.hasTerminalProviderStreamError &&
  isInterruptedToolInputOnlyProviderOutput(parts);

export const PROVIDER_DISCONNECT_CONTINUATION_PROMPT =
  "The previous model connection ended mid-response. Continue from the preserved completed text and tool results. Do not repeat completed tool calls or their side effects. Finish the task from the last durable result.";
