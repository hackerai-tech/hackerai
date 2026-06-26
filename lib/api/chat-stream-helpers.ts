/**
 * Chat Stream Helpers
 *
 * Utility functions extracted from chat-handler to keep it clean and focused.
 */

import type {
  LanguageModel,
  UIMessage,
  UIMessageStreamWriter,
  ToolSet,
  ModelMessage,
  SystemModelMessage,
} from "ai";
import { NoSuchModelError } from "ai";
import type {
  ChatMode,
  ExtraUsageConfig,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
  Todo,
  UserCustomization,
} from "@/types";
import {
  isAnthropicModel,
  isDeepSeekModel,
  myProvider,
} from "@/lib/ai/providers";
import type { ModelName } from "@/lib/ai/providers";
import type { Id } from "@/convex/_generated/dataModel";
import type { UIMessagePart } from "ai";
import {
  writeRateLimitWarning,
  createSummarizationCompletedPart,
  findSummarizationInsertIndex,
} from "@/lib/utils/stream-writer-utils";
import { POINTS_PER_DOLLAR } from "@/lib/rate-limit/token-bucket";
import { countMessagesTokens, safeCountTokens } from "@/lib/token-utils";
import {
  checkAndSummarizeIfNeeded,
  type EnsureSandbox,
  type SummarizationUsage,
} from "@/lib/chat/summarization";
import type { ProviderPromptPressure } from "@/lib/chat/summarization/provider-pressure";
import { getNotes } from "@/lib/db/actions";
import { generateNotesSection } from "@/lib/system-prompt/notes";
import { logger } from "@/lib/logger";
import { UsageTracker } from "@/lib/usage-tracker";
import { ChatSDKError } from "@/lib/errors";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  getExtraUsageBalance,
  getTeamExtraUsageState,
} from "@/lib/extra-usage";
import { systemPrompt } from "@/lib/system-prompt";
import { isAgentMode } from "@/lib/utils/mode-helpers";

/**
 * Check if messages contain file attachments
 */
export function hasFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string }> }>,
): boolean {
  return messages.some((msg) =>
    msg.parts?.some((part) => part.type === "file"),
  );
}

/**
 * Count total file attachments and how many are images
 */
export function countFileAttachments(
  messages: Array<{ parts?: Array<{ type?: string; mediaType?: string }> }>,
): { totalFiles: number; imageCount: number } {
  let totalFiles = 0;
  let imageCount = 0;

  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "file") continue;
      totalFiles++;
      if ((part.mediaType ?? "").startsWith("image/")) {
        imageCount++;
      }
    }
  }

  return { totalFiles, imageCount };
}

/**
 * Remove image file parts from messages. Used for free-tier users continuing
 * chats that already contain images uploaded while paid. Messages that would
 * end up empty get a text placeholder so turn structure stays intact.
 */
export function stripImageAttachments<
  T extends { parts?: Array<{ type?: string; mediaType?: string }> },
>(messages: T[]): T[] {
  return messages.map((msg) => {
    if (!msg.parts) return msg;
    const filtered = msg.parts.filter(
      (p) => !(p.type === "file" && (p.mediaType ?? "").startsWith("image/")),
    );
    if (filtered.length === msg.parts.length) return msg;
    return {
      ...msg,
      parts:
        filtered.length > 0
          ? filtered
          : [
              {
                type: "text",
                text: "[Image attachment hidden — image attachments are a paid-plan feature and aren't available on the free plan.]",
              },
            ],
    } as T;
  });
}

/**
 * Send rate limit warnings based on subscription and rate limit info
 */
export function sendRateLimitWarnings(
  writer: UIMessageStreamWriter,
  options: {
    subscription: SubscriptionTier;
    mode: ChatMode;
    rateLimitInfo: {
      remaining: number;
      limit: number;
      resetTime: Date;
      monthly?: { remaining: number; limit: number; resetTime: Date };
      extraUsagePointsDeducted?: number;
      rateLimitSkipped?: boolean;
    };
    extraUsageConfig?: ExtraUsageConfig;
  },
): void {
  const { subscription, mode, rateLimitInfo, extraUsageConfig } = options;

  if (subscription === "free") {
    // Warn when roughly 30% of daily limit remains (minimum threshold of 1)
    const warningThreshold = Math.max(1, Math.ceil(rateLimitInfo.limit * 0.3));
    if (
      !rateLimitInfo.rateLimitSkipped &&
      rateLimitInfo.remaining <= warningThreshold
    ) {
      writeRateLimitWarning(writer, {
        warningType: "sliding-window",
        remaining: rateLimitInfo.remaining,
        resetTime: rateLimitInfo.resetTime.toISOString(),
        mode,
        subscription,
      });
    }
  } else if (rateLimitInfo.monthly) {
    const canUseExtraUsage =
      !!extraUsageConfig?.enabled &&
      (extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled) &&
      (extraUsageConfig.monthlyRemainingDollars === undefined ||
        extraUsageConfig.monthlyRemainingDollars > 0);
    const isUsingExtraUsage =
      !!rateLimitInfo.extraUsagePointsDeducted &&
      rateLimitInfo.extraUsagePointsDeducted > 0;

    // Paid users with extra usage: warn when credits are being used, including
    // the edge case where the included bucket is empty before output starts.
    if (
      isUsingExtraUsage ||
      (rateLimitInfo.monthly.remaining <= 0 && canUseExtraUsage)
    ) {
      writeRateLimitWarning(writer, {
        warningType: "extra-usage-active",
        bucketType: "monthly",
        resetTime: rateLimitInfo.monthly.resetTime.toISOString(),
        subscription,
        capReason: "extra_usage_active",
      });
    } else {
      // Paid users without extra usage: warn at 75% and 90%
      const usedPercent =
        100 -
        (rateLimitInfo.monthly.remaining / rateLimitInfo.monthly.limit) * 100;

      if (usedPercent >= 75) {
        emitTokenBucketThresholdWarning(writer, {
          usedPercent,
          projectedUsedPoints:
            rateLimitInfo.monthly.limit - rateLimitInfo.monthly.remaining,
          monthlyLimitPoints: rateLimitInfo.monthly.limit,
          resetTime: rateLimitInfo.monthly.resetTime,
          subscription,
          capReason: "monthly_near_limit",
        });
      }
    }
  }
}

/**
 * Inputs to {@link emitTokenBucketThresholdWarning}. Both start-of-stream
 * (`sendRateLimitWarnings`) and mid-stream (`BudgetMonitor`) callers build
 * one of these and let the helper format the dollar/severity payload.
 */
export interface TokenBucketEmitContext {
  /** Used percentage (0–100+), pre-rounding. */
  usedPercent: number;
  /** Points consumed against the monthly bucket so far. */
  projectedUsedPoints: number;
  /** Monthly bucket size in points. */
  monthlyLimitPoints: number;
  /** When the bucket resets. */
  resetTime: Date;
  subscription: SubscriptionTier;
  /** Set when the warning is emitted from inside an active stream. */
  midStream?: boolean;
  /** Set when the response was cut off because the bucket hit 0. */
  cutOff?: boolean;
  /** Monetization/guardrail reason that should drive the client CTA. */
  capReason?: LimitCapReason;
}

export function emitTokenBucketThresholdWarning(
  writer: UIMessageStreamWriter,
  ctx: TokenBucketEmitContext,
): void {
  const remainingPercent = Math.max(0, Math.round(100 - ctx.usedPercent));
  const severity: "info" | "warning" =
    ctx.usedPercent >= 90 ? "warning" : "info";
  writeRateLimitWarning(writer, {
    warningType: "token-bucket",
    bucketType: "monthly",
    remainingPercent,
    resetTime: ctx.resetTime.toISOString(),
    subscription: ctx.subscription,
    severity,
    usedDollars:
      Math.round((ctx.projectedUsedPoints / POINTS_PER_DOLLAR) * 100) / 100,
    limitDollars: ctx.monthlyLimitPoints / POINTS_PER_DOLLAR,
    ...(ctx.capReason ? { capReason: ctx.capReason } : {}),
    ...(ctx.midStream ? { midStream: true } : {}),
    ...(ctx.cutOff ? { cutOff: true } : {}),
  });
}

/**
 * Check if an error is an xAI safety check error (403 from api.x.ai)
 * These are false positives that should be suppressed from logging
 */
export function isXaiSafetyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // Handle both direct errors (from generateText) and wrapped errors (from streamText onError)
  const apiError =
    "error" in error && error.error instanceof Error
      ? (error.error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        })
      : (error as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
        });

  return (
    apiError.statusCode === 403 &&
    typeof apiError.url === "string" &&
    apiError.url.includes("api.x.ai") &&
    typeof apiError.responseBody === "string"
  );
}

/**
 * Check if an error is a provider API error that should trigger fallback
 * Specifically targets Google/Gemini INVALID_ARGUMENT errors
 */
export function isProviderApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    statusCode?: number;
    responseBody?: string;
    data?: {
      error?: {
        code?: number;
        message?: string;
        metadata?: { raw?: string; provider_name?: string };
      };
    };
  };

  // Must be a 400 error
  if (err.statusCode !== 400 && err.data?.error?.code !== 400) return false;

  // Check for INVALID_ARGUMENT in response body or nested metadata
  const responseBody = err.responseBody || "";
  const rawMetadata = err.data?.error?.metadata?.raw || "";
  const combined = responseBody + rawMetadata;

  return combined.includes("INVALID_ARGUMENT");
}

/**
 * Compute total context usage from messages.
 */
export interface ContextUsageData {
  usedTokens: number;
  maxTokens: number;
}

export function computeContextUsage(
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number>,
  systemTokens: number,
  maxTokens: number,
): ContextUsageData {
  const usedTokens = systemTokens + countMessagesTokens(messages, fileTokens);
  return { usedTokens, maxTokens };
}

export function isContextUsageEnabled(
  subscription: SubscriptionTier,
  mode?: ChatMode,
): boolean {
  if (subscription !== "free") return true;
  return mode === "agent";
}

export interface SummarizationStepResult {
  needsSummarization: boolean;
  summarizedMessages?: UIMessage[];
  contextUsage?: ContextUsageData;
  summarizationUsage?: SummarizationUsage;
}

export async function runSummarizationStep(options: {
  messages: UIMessage[];
  subscription: SubscriptionTier;
  languageModel: LanguageModel;
  mode: ChatMode;
  writer: UIMessageStreamWriter;
  chatId: string | null;
  fileTokens: Record<Id<"files">, number>;
  todos: Todo[];
  abortSignal?: AbortSignal;
  ensureSandbox?: EnsureSandbox;
  systemPromptTokens: number;
  ctxSystemTokens: number;
  ctxMaxTokens: number;
  providerInputTokens?: number;
  chatSystemPrompt: string;
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, unknown>>;
  modelMessages?: ModelMessage[];
  transcriptMessages?: UIMessage[];
  providerPromptPressure?: ProviderPromptPressure | null;
}): Promise<SummarizationStepResult> {
  const { needsSummarization, summarizedMessages, summarizationUsage } =
    await checkAndSummarizeIfNeeded({
      uiMessages: options.messages,
      subscription: options.subscription,
      languageModel: options.languageModel,
      mode: options.mode,
      writer: options.writer,
      chatId: options.chatId,
      fileTokens: options.fileTokens,
      todos: options.todos,
      abortSignal: options.abortSignal,
      ensureSandbox: options.ensureSandbox,
      systemPromptTokens: options.systemPromptTokens,
      providerInputTokens: options.providerInputTokens ?? 0,
      chatSystemPrompt: options.chatSystemPrompt,
      tools: options.tools,
      providerOptions: options.providerOptions,
      modelMessages: options.modelMessages,
      transcriptMessages: options.transcriptMessages,
      maxTokensOverride: options.ctxMaxTokens,
      providerPromptPressure: options.providerPromptPressure,
    });

  if (!needsSummarization) {
    return { needsSummarization: false };
  }

  const contextUsage = isContextUsageEnabled(options.subscription, options.mode)
    ? computeContextUsage(
        summarizedMessages,
        options.fileTokens,
        options.ctxSystemTokens,
        options.ctxMaxTokens,
      )
    : undefined;

  return {
    needsSummarization: true,
    summarizedMessages,
    contextUsage,
    summarizationUsage,
  };
}

/**
 * Tracks summarization state and handles inserting the summarization badge
 * into message parts at the correct position during save.
 */
export class SummarizationTracker {
  hasSummarized = false;
  private parts: UIMessagePart<any, any>[] = [];
  private atStep: number | undefined;

  /**
   * Record that summarization completed at the given step and accumulate
   * usage into the provided UsageTracker.
   */
  recordSummarization(
    stepNumber: number,
    usage: SummarizationUsage | undefined,
    usageTracker: UsageTracker,
  ): void {
    this.hasSummarized = true;
    this.atStep = stepNumber;
    this.parts.push(createSummarizationCompletedPart());

    if (usage) {
      usageTracker.inputTokens += usage.inputTokens;
      usageTracker.outputTokens += usage.outputTokens;
      usageTracker.summarizationOutputTokens += usage.outputTokens;
      usageTracker.cacheReadTokens += usage.cacheReadTokens || 0;
      usageTracker.cacheWriteTokens += usage.cacheWriteTokens || 0;
      if (usage.cost) {
        usageTracker.providerCost += usage.cost;
      }
    }
  }

  /**
   * Insert summarization parts into an assistant message at the correct
   * position (before the step-start for the step where summarization happened).
   * Returns the original message unchanged if no summarization occurred.
   */
  processMessageForSave<T extends { role: string; parts: any[] }>(
    message: T,
  ): T {
    if (message.role !== "assistant" || this.parts.length === 0) {
      return message;
    }
    const parts = [...message.parts];
    const idx = findSummarizationInsertIndex(parts, this.atStep ?? 0);
    parts.splice(idx, 0, ...this.parts);
    return { ...message, parts };
  }
}

/**
 * OpenRouter `models` fallback chain, expressed in local registry keys.
 *
 * When the primary 5xx's, rate-limits, or otherwise errors before any tokens
 * stream, OpenRouter rolls forward through this list and bills at the served
 * model's rate (response.modelId reflects what actually ran).
 *
 * Claude chats are repaired for Anthropic-compatible message shapes before
 * this fallback can fire. Claude agent calls use the cheaper Kimi fallback
 * while the run is text-only, then switch to multimodal-capable fallbacks once
 * image tool results enter the context.
 *
 * Keys and values are registry names (see lib/ai/providers.ts) — the actual
 * OpenRouter slugs are resolved at request-build time so this stays in sync
 * with the registry.
 */
const MODEL_FALLBACK_CHAIN: Partial<Record<ModelName, readonly ModelName[]>> = {
  "ask-model-free": ["fallback-ask-model"],
  "agent-model-free": ["fallback-agent-model"],
  "model-deepseek-v4-flash": ["fallback-ask-model"],
  "model-deepseek-v4-pro": ["fallback-ask-model"],
  "ask-model": ["fallback-ask-model"],
  "agent-model": ["fallback-grok-4.3"],
  "model-grok-4.3": ["fallback-ask-model"],
  "model-gemini-3-flash": ["fallback-ask-model"],
  "model-kimi-k2.7-code": ["fallback-grok-4.3"],
  "model-kimi-k2.6": ["fallback-grok-4.3"],
};

const AUTO_MODEL_KEYS = new Set<string>([
  "ask-model",
  "ask-model-free",
  "agent-model",
  "agent-model-free",
]);

export function isAutoModelSelectionForRetry({
  selectedModel,
  selectedModelOverride,
}: {
  selectedModel: string;
  selectedModelOverride?: SelectedModel | null;
}): boolean {
  return (
    !selectedModelOverride ||
    selectedModelOverride === "auto" ||
    AUTO_MODEL_KEYS.has(selectedModel)
  );
}

const ANTHROPIC_FALLBACK_CHAIN_BY_MODE: Record<ChatMode, readonly ModelName[]> =
  {
    agent: ["model-kimi-k2.7-code", "fallback-grok-4.3"],
    ask: ["model-grok-4.3"],
  };

const ANTHROPIC_MULTIMODAL_AGENT_FALLBACK_CHAIN = [
  "fallback-grok-4.3",
] as const satisfies readonly ModelName[];

// Standard Ask can route text-only prompts to DeepSeek and media prompts to
// Grok. Keep those route keys and their persisted Grok alias on one effort
// level so they do not drift.
const ASK_STANDARD_REASONING_MODELS = [
  "model-deepseek-v4-pro",
  "ask-model",
  "model-grok-4.3",
  "model-gemini-3-flash",
] as const satisfies readonly ModelName[];

const ASK_MEDIUM_REASONING_MODELS = [
  ...ASK_STANDARD_REASONING_MODELS,
  "model-sonnet-4.6",
  "model-opus-4.6",
] as const satisfies readonly ModelName[];

const isAskMediumReasoningModel = (modelName?: string): boolean =>
  typeof modelName === "string" &&
  (ASK_MEDIUM_REASONING_MODELS as readonly string[]).includes(modelName);

const ASK_KIMI_REASONING_MODELS = [
  "model-kimi-k2.7-code",
  "model-kimi-k2.6",
] as const satisfies readonly ModelName[];

const isAskKimiReasoningModel = (modelName?: string): boolean =>
  typeof modelName === "string" &&
  (ASK_KIMI_REASONING_MODELS as readonly string[]).includes(modelName);

type FallbackOptions = {
  hasMultimodalToolResults?: boolean;
  reasoningOverride?: ProviderReasoningOverride;
};

export type ProviderReasoningOverride = {
  enabled: boolean;
  effort?: string;
  exclude?: boolean;
};

const getFallbackKeys = (
  modelName?: string,
  mode?: ChatMode,
  options: FallbackOptions = {},
): readonly ModelName[] | undefined => {
  if (!modelName) return undefined;
  if (modelName === "model-opus-4.6" || modelName === "model-sonnet-4.6") {
    if (mode === "agent" && options.hasMultimodalToolResults) {
      return ANTHROPIC_MULTIMODAL_AGENT_FALLBACK_CHAIN;
    }
    return ANTHROPIC_FALLBACK_CHAIN_BY_MODE[mode ?? "agent"];
  }
  return MODEL_FALLBACK_CHAIN[modelName as ModelName];
};

export function getRetryFallbackModel(
  modelName: ModelName,
  mode: ChatMode,
): ModelName {
  if (isDeepSeekModel(modelName)) {
    return mode === "agent" ? "fallback-agent-model" : "fallback-ask-model";
  }
  if (
    modelName === "ask-model" ||
    modelName === "model-grok-4.3" ||
    modelName === "model-gemini-3-flash"
  ) {
    return "fallback-ask-model";
  }
  return "fallback-grok-4.3";
}

const resolveSlug = (modelName: string): string | undefined => {
  try {
    const lm = myProvider.languageModel(modelName) as { modelId?: unknown };
    return typeof lm?.modelId === "string" ? lm.modelId : undefined;
  } catch (err) {
    if (err instanceof NoSuchModelError) {
      // Stale fallback entry — treat as "no slug" so it can't bring down the
      // primary request. Anything else is an unexpected failure and surfaces.
      return undefined;
    }
    throw err;
  }
};

/**
 * Resolve a model's fallback chain to OpenRouter slugs.
 * Returns an empty array if the model has no chain or all entries are stale.
 */
export function getFallbackSlugs(
  modelName?: string,
  mode?: ChatMode,
  options: FallbackOptions = {},
): string[] {
  const fallbackKeys = getFallbackKeys(modelName, mode, options);
  return (
    fallbackKeys
      ?.map((key) => resolveSlug(key))
      .filter((s): s is string => typeof s === "string" && s.length > 0) ?? []
  );
}

/**
 * Build provider options for streamText
 */
export function buildProviderOptions(
  isReasoningModel: boolean,
  userId?: string,
  modelName?: string,
  mode?: ChatMode,
  options: FallbackOptions = {},
) {
  const modelId = modelName ? resolveSlug(modelName) : undefined;
  const isDeepSeekV4 = modelId?.startsWith("deepseek/deepseek-v4") ?? false;
  const fallbackSlugs = getFallbackSlugs(modelName, mode, options);
  const reasoning =
    options.reasoningOverride ??
    (isReasoningModel
      ? {
          enabled: true,
          ...(isDeepSeekV4 && { effort: "xhigh" }),
        }
      : mode === "ask" && isAskKimiReasoningModel(modelName)
        ? {
            enabled: true,
          }
        : mode === "ask" && isAskMediumReasoningModel(modelName)
          ? {
              enabled: true,
              effort: "medium",
            }
          : { enabled: false });

  return {
    openrouter: {
      reasoning,
      ...(userId && { user: userId }),
      ...(fallbackSlugs.length > 0 && { models: fallbackSlugs }),
    },
  } as const;
}

const ANTHROPIC_CACHE_BREAKPOINT = {
  openrouter: { cacheControl: { type: "ephemeral" as const } },
};

/**
 * Build a system prompt with an Anthropic cache breakpoint.
 * Returns a structured system message for Anthropic models, plain string otherwise.
 */
export function buildSystemPrompt(
  systemPrompt: string,
  modelName: string,
): string | SystemModelMessage {
  if (!isAnthropicModel(modelName)) return systemPrompt;
  return {
    role: "system",
    content: systemPrompt,
    providerOptions: ANTHROPIC_CACHE_BREAKPOINT,
  } satisfies SystemModelMessage;
}

/**
 * Add an Anthropic cache breakpoint to the last user message.
 * This tells Anthropic to cache everything up to and including that message,
 * maximizing cache hits on subsequent agentic steps.
 */
export function addCacheBreakpointToLastUserMessage<
  T extends Array<Record<string, unknown>>,
>(messages: T, modelName: string): T {
  if (!isAnthropicModel(modelName)) return messages;
  const result = [...messages] as T;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      result[i] = {
        ...result[i],
        providerOptions: {
          ...((result[i].providerOptions as Record<string, unknown>) || {}),
          ...ANTHROPIC_CACHE_BREAKPOINT,
        },
      };
      break;
    }
  }
  return result;
}

/**
 * Appends a <system-reminder> block to the last user message's text part.
 * Returns a new array (does not mutate input).
 */
export function appendSystemReminderToLastUserMessage(
  messages: UIMessage[],
  reminderContent: string,
): UIMessage[] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      const parts = [...(result[i].parts || [])];
      const textPartIndex = parts.findIndex((p) => p.type === "text");

      if (textPartIndex >= 0) {
        const textPart = parts[textPartIndex] as { type: "text"; text: string };
        parts[textPartIndex] = {
          ...textPart,
          text: `${textPart.text}\n\n<system-reminder>\n${reminderContent}\n</system-reminder>`,
        };
      } else {
        parts.push({
          type: "text" as const,
          text: `<system-reminder>\n${reminderContent}\n</system-reminder>`,
        });
      }

      result[i] = { ...result[i], parts };
      break;
    }
  }
  return result;
}

/**
 * Fetches user notes and injects them into messages via <system-reminder>.
 * Returns the (possibly updated) messages array.
 */
export async function injectNotesIntoMessages(
  messages: UIMessage[],
  opts: {
    userId: string;
    subscription: SubscriptionTier;
    shouldIncludeNotes: boolean;
    isTemporary?: boolean;
  },
): Promise<UIMessage[]> {
  if (!opts.shouldIncludeNotes || opts.isTemporary) return messages;

  try {
    const notes = await getNotes({
      userId: opts.userId,
      subscription: opts.subscription,
    });
    const notesContent = generateNotesSection(notes);
    if (!notesContent) return messages;

    return appendSystemReminderToLastUserMessage(messages, notesContent);
  } catch (error) {
    logger.warn("Failed to fetch notes, continuing without them", {
      userId: opts.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return messages;
  }
}

// Regex to match a system-reminder block that contains <notes>.
// Uses \s* instead of literal \n so it stays in sync even if the
// template strings in appendSystemReminderToLastUserMessage or
// generateNotesSection change their whitespace slightly.
const NOTES_REMINDER_REGEX =
  /<system-reminder>\s*<notes>[\s\S]*?<\/notes>\s*<\/system-reminder>/;

/**
 * Replaces the notes <system-reminder> block inside a text string.
 * Returns the original string unchanged if no notes block is found.
 */
export function replaceNotesBlock(
  text: string,
  newNotesContent: string,
): string {
  if (NOTES_REMINDER_REGEX.test(text)) {
    return newNotesContent
      ? text.replace(
          NOTES_REMINDER_REGEX,
          `<system-reminder>\n${newNotesContent}\n</system-reminder>`,
        )
      : text.replace(NOTES_REMINDER_REGEX, "");
  }
  return text;
}

/**
 * Updates the notes in model messages (ModelMessage[]) from prepareStep.
 * Preserves full conversation history (tool calls, results, assistant messages).
 *
 * The AI SDK does NOT preserve `<system-reminder>` text that was injected into
 * user messages via `appendSystemReminderToLastUserMessage`. So on subsequent
 * agentic steps, the notes block will be missing from prepareStep's messages.
 *
 * Strategy:
 * 1. Try to find and replace an existing `<notes>` block (in case the SDK
 *    does preserve it in some path).
 * 2. If no block is found, append the notes as a new `<system-reminder>` to
 *    the last user message — this ensures the model always sees fresh notes.
 */
export async function refreshNotesInModelMessages(
  messages: Array<Record<string, unknown>>,
  opts: {
    userId: string;
    subscription: SubscriptionTier;
    shouldIncludeNotes: boolean;
    isTemporary?: boolean;
  },
): Promise<Array<Record<string, unknown>>> {
  if (!opts.shouldIncludeNotes || opts.isTemporary) return messages;

  try {
    const notes = await getNotes({
      userId: opts.userId,
      subscription: opts.subscription,
    });
    const newNotesContent = generateNotesSection(notes);

    // First pass: try to replace (or remove) an existing notes block.
    // replaceNotesBlock handles empty newNotesContent by removing the block.
    const result = [...messages];
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      if (msg.role !== "user") continue;

      const content = msg.content;

      if (typeof content === "string") {
        const updated = replaceNotesBlock(content, newNotesContent);
        if (updated !== content) {
          result[i] = { ...msg, content: updated };
          return result;
        }
      } else if (Array.isArray(content)) {
        const parts = [...(content as Array<Record<string, unknown>>)];
        for (let j = 0; j < parts.length; j++) {
          if (parts[j].type !== "text") continue;
          const text = parts[j].text as string;
          const updated = replaceNotesBlock(text, newNotesContent);
          if (updated !== text) {
            parts[j] = { ...parts[j], text: updated };
            result[i] = { ...msg, content: parts };
            return result;
          }
        }
      }
    }

    // Nothing to append if user has no notes (and no existing block to remove)
    if (!newNotesContent) return messages;

    // No existing notes block found (AI SDK strips <system-reminder> from its
    // internal message state). Append the notes to the last user message.
    return appendReminderToModelMessages(result, newNotesContent);
  } catch (error) {
    logger.warn("Failed to refresh notes in prepareStep, continuing without", {
      userId: opts.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return messages;
  }
}

/**
 * Appends a <system-reminder> block to the last user message in a ModelMessage array.
 * Used in prepareStep to inject runtime reminders without mutating the original.
 */
export function appendReminderToModelMessages(
  messages: Array<Record<string, unknown>>,
  reminderText: string,
): Array<Record<string, unknown>> {
  const result = [...messages];
  const reminder = `<system-reminder>\n${reminderText}\n</system-reminder>`;
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      result[i] = { ...msg, content: `${content}\n\n${reminder}` };
    } else if (Array.isArray(content)) {
      const parts = [...content];
      const textIdx = parts.findLastIndex(
        (p: unknown) => (p as Record<string, unknown>).type === "text",
      );
      if (textIdx >= 0) {
        const part = parts[textIdx] as Record<string, unknown>;
        parts[textIdx] = {
          ...part,
          text: `${part.text as string}\n\n${reminder}`,
        };
      } else {
        parts.push({ type: "text", text: reminder });
      }
      result[i] = { ...msg, content: parts };
    }
    break;
  }
  return result;
}

/**
 * Shared logic for the post-prune section of prepareStep in both
 * chat-handler.ts and agent-task.ts: refreshes notes if a note tool
 * was used.
 */
export async function applyPrepareStepReminders(
  messages: Array<Record<string, unknown>>,
  opts: {
    toolResults: unknown[];
    noteInjectionOpts: {
      userId: string;
      subscription: SubscriptionTier;
      shouldIncludeNotes: boolean;
      isTemporary?: boolean;
    };
  },
): Promise<Array<Record<string, unknown>>> {
  // Refresh notes if a note tool was used
  const wasNoteModified =
    Array.isArray(opts.toolResults) &&
    opts.toolResults.some((r) =>
      ["create_note", "update_note", "delete_note"].includes(
        (r as { toolName?: string })?.toolName ?? "",
      ),
    );

  if (wasNoteModified) {
    return (await refreshNotesInModelMessages(
      messages,
      opts.noteInjectionOpts,
    )) as Array<Record<string, unknown>>;
  }

  return messages;
}

/**
 * Free-tier agent mode is restricted to the local sandbox.
 * Model overrides are normalized to auto before stream setup.
 * Throws ChatSDKError("forbidden:chat") if the sandbox gate fails.
 */
export function assertFreeAgentGates(args: {
  mode: ChatMode;
  subscription: SubscriptionTier;
  sandboxPreference: SandboxPreference | undefined;
}): void {
  const { mode, subscription, sandboxPreference } = args;
  if (!isAgentMode(mode) || subscription !== "free") return;

  const isLocalSandbox = sandboxPreference && sandboxPreference !== "e2b";
  if (!isLocalSandbox) {
    throw new ChatSDKError(
      "forbidden:chat",
      "Agent mode on the free plan requires a local sandbox. Install the desktop app or upgrade to Pro for cloud access.",
    );
  }
}

/**
 * Build the extra-usage config for paid users with `extra_usage_enabled`.
 * Falls back to an optimistic config if the balance lookup fails so a
 * transient Convex error doesn't silently disable extra usage and force
 * the user into the hard subscription limit.
 */
export async function buildExtraUsageConfig(args: {
  userId: string;
  subscription: SubscriptionTier;
  userCustomization: UserCustomization | null | undefined;
  organizationId?: string;
}): Promise<ExtraUsageConfig | undefined> {
  const { userId, subscription, userCustomization, organizationId } = args;
  if (subscription === "free") return undefined;

  // Team users: extra usage is org-funded and admin-controlled. Personal
  // extra_usage settings are ignored — overflow routes through the team pool.
  if (subscription === "team") {
    if (!organizationId) return undefined;
    const state = await getTeamExtraUsageState(organizationId, userId);
    if (!state) {
      console.warn(
        `[chat-handler] getTeamExtraUsageState returned null for org ${organizationId}, using optimistic extra usage config`,
      );
      return { enabled: true, hasBalance: true, autoReloadEnabled: false };
    }
    if (!state.enabled || state.memberDisabled) return undefined;
    if (state.balanceDollars > 0 || state.autoReloadEnabled) {
      return {
        enabled: true,
        hasBalance: state.balanceDollars > 0,
        balanceDollars: state.balanceDollars,
        autoReloadEnabled: state.autoReloadEnabled,
        ...(state.monthlyCapDollars !== undefined && {
          monthlyCapDollars: state.monthlyCapDollars,
        }),
        ...(state.monthlySpentDollars !== undefined && {
          monthlySpentDollars: state.monthlySpentDollars,
        }),
        ...(state.monthlyRemainingDollars !== undefined && {
          monthlyRemainingDollars: state.monthlyRemainingDollars,
        }),
      };
    }
    return undefined;
  }

  if (!(userCustomization?.extra_usage_enabled ?? false)) return undefined;

  const balanceInfo = await getExtraUsageBalance(userId);

  if (!balanceInfo) {
    console.warn(
      `[chat-handler] getExtraUsageBalance returned null for user ${userId}, using optimistic extra usage config`,
    );
    return { enabled: true, hasBalance: true, autoReloadEnabled: false };
  }

  if (balanceInfo.balanceDollars > 0 || balanceInfo.autoReloadEnabled) {
    return {
      enabled: true,
      hasBalance: balanceInfo.balanceDollars > 0,
      balanceDollars: balanceInfo.balanceDollars,
      autoReloadEnabled: balanceInfo.autoReloadEnabled,
      ...(balanceInfo.monthlyCapDollars !== undefined && {
        monthlyCapDollars: balanceInfo.monthlyCapDollars,
      }),
      ...(balanceInfo.monthlySpentDollars !== undefined && {
        monthlySpentDollars: balanceInfo.monthlySpentDollars,
      }),
      ...(balanceInfo.monthlyRemainingDollars !== undefined && {
        monthlyRemainingDollars: balanceInfo.monthlyRemainingDollars,
      }),
    };
  }
  return undefined;
}

/**
 * Pre-flight token estimate used to size the rate-limit deduction before
 * the actual stream runs. File tokens are excluded (PDF counts are
 * inaccurate; deductUsage reconciles against real provider cost). Tool
 * schemas can't be computed here (they depend on sandboxManager), so we
 * approximate: ~1500 for agent (~8 tools), ~500 for ask (~4 tools).
 */
export async function estimatePreflightInputTokens(args: {
  mode: ChatMode;
  subscription: SubscriptionTier;
  userId: string;
  selectedModel: ModelName;
  userCustomization: UserCustomization | null | undefined;
  temporary: boolean | undefined;
  truncatedMessages: UIMessage[];
}): Promise<number> {
  const {
    mode,
    subscription,
    userId,
    selectedModel,
    userCustomization,
    temporary,
    truncatedMessages,
  } = args;
  if (!isAgentMode(mode) && subscription === "free") return 0;

  const messageTokens = countMessagesTokens(truncatedMessages);
  const estimatedSystemPrompt = await systemPrompt(
    userId,
    mode,
    subscription,
    selectedModel,
    userCustomization,
    temporary,
    null,
  );
  const systemTokens = safeCountTokens(estimatedSystemPrompt);
  const toolSchemaOverhead = isAgentMode(mode) ? 1500 : 500;
  return messageTokens + systemTokens + toolSchemaOverhead;
}
