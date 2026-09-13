import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { createProviderContentBlockedFinishReasonError } from "@/lib/utils/error-utils";

type MiddlewareGenerateOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapGenerate"]>
>[0];
type LanguageModelGenerateResult = Awaited<
  ReturnType<MiddlewareGenerateOptions["doGenerate"]>
>;
type LanguageModelContentPart = LanguageModelGenerateResult["content"][number];

type MiddlewareStreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type LanguageModelStreamResult = Awaited<
  ReturnType<MiddlewareStreamOptions["doStream"]>
>;
type LanguageModelStreamPart =
  LanguageModelStreamResult["stream"] extends ReadableStream<infer T>
    ? T
    : never;

type GuardedToolPart = {
  type: string;
  id?: string;
  toolCallId?: string;
  toolName?: string;
};

type ToolCallDecision = {
  retained: boolean;
  toolName: string;
};

export type ProviderToolCallDropReport = {
  droppedToolCallCount: number;
  maxToolCalls: number;
};

export type ProviderResponseGuardOptions = {
  maxToolCalls?: number;
  perToolCallLimits?: Readonly<Record<string, number>>;
  onToolCallsDropped?: (report: ProviderToolCallDropReport) => void;
};

// One provider response maps to one AI SDK step, whose tool executions run
// concurrently. Thirty-two preserves deliberate parallel work while bounding
// the promises, sandbox operations, and side effects one response can enqueue.
export const MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE = 32;

export const DEFAULT_PROVIDER_TOOL_CALL_LIMITS = Object.freeze({
  // This tool durably blocks the parent run, so duplicate calls in one model
  // turn are redundant and can otherwise create competing wait operations.
  wait_for_agents: 1,
});

const normalizedLimit = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;

const createToolCallLimiter = (options: ProviderResponseGuardOptions) => {
  const maxToolCalls = normalizedLimit(
    options.maxToolCalls,
    MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE,
  );
  const perToolCallLimits: Readonly<Record<string, number>> =
    options.perToolCallLimits ?? DEFAULT_PROVIDER_TOOL_CALL_LIMITS;
  const retainedByToolName = new Map<string, number>();
  const pendingByToolCallId = new Map<string, ToolCallDecision[]>();
  const activeByToolCallId = new Map<string, ToolCallDecision>();
  const completedByToolCallId = new Map<string, ToolCallDecision>();
  let retainedCallCount = 0;
  let droppedToolCallCount = 0;
  let reported = false;

  const decide = (toolName: string): ToolCallDecision => {
    const toolLimit = perToolCallLimits[toolName];
    const retainedForTool = retainedByToolName.get(toolName) ?? 0;
    const retained =
      retainedCallCount < maxToolCalls &&
      (toolLimit === undefined ||
        retainedForTool < normalizedLimit(toolLimit, maxToolCalls));

    if (retained) {
      retainedCallCount += 1;
      retainedByToolName.set(toolName, retainedForTool + 1);
    }

    return { retained, toolName };
  };

  const queuePendingDecision = (
    toolCallId: string,
    decision: ToolCallDecision,
  ) => {
    const pending = pendingByToolCallId.get(toolCallId) ?? [];
    pending.push(decision);
    pendingByToolCallId.set(toolCallId, pending);
  };

  const takePendingDecision = (
    toolCallId: string,
    toolName: string,
  ): ToolCallDecision => {
    const pending = pendingByToolCallId.get(toolCallId);
    const pendingIndex = pending?.findIndex(
      (decision) => decision.toolName === toolName,
    );
    if (pending && pendingIndex !== undefined && pendingIndex >= 0) {
      const [decision] = pending.splice(pendingIndex, 1);
      if (pending.length === 0) pendingByToolCallId.delete(toolCallId);
      return decision;
    }
    return decide(toolName);
  };

  const shouldForward = (part: GuardedToolPart): boolean => {
    switch (part.type) {
      case "tool-input-start": {
        if (typeof part.id !== "string" || typeof part.toolName !== "string") {
          return true;
        }
        const decision = decide(part.toolName);
        if (decision.retained) {
          // Only retained calls occupy correlation state, so even a malformed
          // response with unbounded starts cannot grow these maps past the cap.
          queuePendingDecision(part.id, decision);
          activeByToolCallId.set(part.id, decision);
        }
        return decision.retained;
      }
      case "tool-input-delta":
      case "tool-input-end": {
        if (typeof part.id !== "string") return true;
        const decision = activeByToolCallId.get(part.id);
        if (part.type === "tool-input-end") {
          activeByToolCallId.delete(part.id);
        }
        return decision?.retained ?? false;
      }
      case "tool-call": {
        if (
          typeof part.toolCallId !== "string" ||
          typeof part.toolName !== "string"
        ) {
          return true;
        }
        const decision = takePendingDecision(part.toolCallId, part.toolName);
        if (decision.retained) {
          completedByToolCallId.set(part.toolCallId, decision);
        } else {
          droppedToolCallCount += 1;
        }
        return decision.retained;
      }
      case "tool-approval-request":
      case "tool-result": {
        if (typeof part.toolCallId !== "string") return true;
        return completedByToolCallId.get(part.toolCallId)?.retained ?? false;
      }
      default:
        return true;
    }
  };

  const reportDrops = () => {
    if (reported || droppedToolCallCount === 0) return;
    reported = true;
    try {
      options.onToolCallsDropped?.({
        droppedToolCallCount,
        maxToolCalls,
      });
    } catch (error) {
      console.error("[provider-response-guard] drop reporter failed", {
        event: "provider_tool_call_guard_report_failed",
        droppedToolCallCount,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };

  return { shouldForward, reportDrops };
};

const isContentFilterFinishPart = (part: LanguageModelStreamPart): boolean =>
  part.type === "finish" && part.finishReason.unified === "content-filter";

export const guardLanguageModelProviderResponse = (
  model: LanguageModel,
  options: ProviderResponseGuardOptions = {},
): LanguageModel => {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        const limiter = createToolCallLimiter(options);
        const content = result.content.filter((part) =>
          limiter.shouldForward(part as GuardedToolPart),
        );
        limiter.reportDrops();
        return { ...result, content };
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        const limiter = createToolCallLimiter(options);
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelStreamPart,
              LanguageModelStreamPart
            >({
              transform(part, controller) {
                if (isContentFilterFinishPart(part)) {
                  controller.enqueue({
                    type: "error",
                    error: createProviderContentBlockedFinishReasonError(),
                  });
                }
                if (limiter.shouldForward(part as GuardedToolPart)) {
                  controller.enqueue(part);
                }
                if (part.type === "finish") limiter.reportDrops();
              },
              flush() {
                limiter.reportDrops();
              },
            }),
          ),
        };
      },
    },
  });
};

export type { LanguageModelContentPart, LanguageModelStreamPart };
