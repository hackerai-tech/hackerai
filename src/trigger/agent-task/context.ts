import type { UIMessagePart } from "ai";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import type { ChatLogger } from "@/lib/api/chat-logger";
import type { createTools } from "@/lib/ai/tools";
import type { createTrackedProvider } from "@/lib/ai/providers";
import { deserializeRateLimitInfo } from "./rate-limit";
import { createMetadataWriter } from "./metadata-writer";
import { setupAgentChatLogger } from "./chat-logger-setup";
import { deductUsage } from "@/lib/rate-limit";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { MetadataEvent } from "../streams";
import { appendMetadata } from "./metadata-writer";

export type AgentStreamContext = {
  payload: AgentTaskPayload;
  rateLimitInfo: ReturnType<typeof deserializeRateLimitInfo>;
  metadataWriter: ReturnType<typeof createMetadataWriter>;
  chatLogger: ChatLogger;
  appendMetadata: (event: MetadataEvent) => Promise<void>;
  /** Set by orchestrator after createTools() */
  tools: ReturnType<typeof createTools>["tools"];
  getTodoManager: ReturnType<typeof createTools>["getTodoManager"];
  getFileAccumulator: ReturnType<typeof createTools>["getFileAccumulator"];
  sandboxManager: ReturnType<typeof createTools>["sandboxManager"];
  ensureSandbox: ReturnType<typeof createTools>["ensureSandbox"];
  sandboxContext: string | null;
  titlePromise: Promise<string | undefined>;
  trackedProvider: ReturnType<typeof createTrackedProvider>;
  currentSystemPrompt: string;
  configuredModelId: string;
  streamStartTime: number;
  shouldEnableReasoning: boolean;
  summarizationParts: UIMessagePart<
    Record<string, unknown>,
    Record<string, { input: unknown; output: unknown }>
  >[];
  finalMessages: AgentTaskPayload["messages"];
  activeAssistantMessageId: string;
  hasSummarized: boolean;
  stoppedDueToTokenExhaustion: boolean;
  lastStepInputTokens: number;
  streamFinishReason: string | undefined;
  streamUsage: Record<string, unknown> | undefined;
  responseModel: string | undefined;
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
  accumulatedProviderCost: number;
  hasDeductedUsage: boolean;
  deductAccumulatedUsage: () => Promise<void>;
};

/** Fields set by createAgentStreamContext(); orchestrator adds the rest before createStream. */
export type EarlyAgentStreamContext = Omit<
  AgentStreamContext,
  | "tools"
  | "getTodoManager"
  | "getFileAccumulator"
  | "sandboxManager"
  | "ensureSandbox"
  | "sandboxContext"
  | "titlePromise"
  | "trackedProvider"
  | "currentSystemPrompt"
  | "configuredModelId"
  | "streamStartTime"
>;

export function createAgentStreamContext(
  payload: AgentTaskPayload,
): EarlyAgentStreamContext {
  const serializedRateLimitInfo = payload.rateLimitInfo;
  const rateLimitInfo = deserializeRateLimitInfo(serializedRateLimitInfo);
  const metadataWriter = createMetadataWriter();
  const chatLogger = setupAgentChatLogger(payload, serializedRateLimitInfo);

  const summarizationParts: UIMessagePart<
    Record<string, unknown>,
    Record<string, { input: unknown; output: unknown }>
  >[] = [];

  const ctx: EarlyAgentStreamContext = {
    payload,
    rateLimitInfo,
    metadataWriter,
    chatLogger,
    appendMetadata,
    shouldEnableReasoning: isAgentMode(payload.mode),
    summarizationParts,
    finalMessages: payload.messages,
    activeAssistantMessageId: payload.assistantMessageId,
    hasSummarized: false,
    stoppedDueToTokenExhaustion: false,
    lastStepInputTokens: 0,
    streamFinishReason: undefined,
    streamUsage: undefined,
    responseModel: undefined,
    accumulatedInputTokens: 0,
    accumulatedOutputTokens: 0,
    accumulatedProviderCost: 0,
    hasDeductedUsage: false,
    deductAccumulatedUsage: async () => {
      const { userId, subscription, estimatedInputTokens, extraUsageConfig } =
        payload;
      if (ctx.hasDeductedUsage || subscription === "free") return;
      if (
        (ctx.accumulatedInputTokens ?? 0) > 0 ||
        (ctx.accumulatedOutputTokens ?? 0) > 0
      ) {
        await deductUsage(
          userId,
          subscription,
          estimatedInputTokens,
          ctx.accumulatedInputTokens ?? 0,
          ctx.accumulatedOutputTokens ?? 0,
          extraUsageConfig ?? undefined,
          (ctx.accumulatedProviderCost ?? 0) > 0
            ? ctx.accumulatedProviderCost
            : undefined,
        );
        ctx.hasDeductedUsage = true;
      }
    },
  };

  return ctx;
}
