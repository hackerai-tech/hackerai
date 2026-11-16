import type { ModelMessage } from "ai";
import { safeCountTokens } from "@/lib/token-utils";

/**
 * Failure-only projection breakdown for `agent_context_budget_exceeded`.
 *
 * The final send guard measures the current prepared request, while the
 * compaction decision for the same step may have measured an earlier
 * projection. These fields compare the two and isolate the attached OpenRouter
 * file annotations without logging content, hashes, names or URLs.
 */
export const CONTEXT_BUDGET_PROJECTION_DIAGNOSTIC_VERSION = 1;

/** UTF-16 code units; checked before tokenization so a huge body is never tokenized. */
export const CONTEXT_BUDGET_DIAGNOSTIC_MAX_CHARS = 1_048_576;

export type ContextBudgetDecision =
  | { source: "durable_check" | "rolling_check"; inputTokens: number }
  | { source: "not_evaluated" };

export const CONTEXT_BUDGET_DECISION_NOT_EVALUATED: ContextBudgetDecision =
  Object.freeze({ source: "not_evaluated" });

export type WithoutFileAnnotationsStatus =
  "not_present" | "measured" | "size_cap" | "unavailable";

export type ContextBudgetProjectionDiagnostics = {
  context_budget_projection_diagnostic_version: typeof CONTEXT_BUDGET_PROJECTION_DIAGNOSTIC_VERSION;
  context_budget_step_index?: number;
  context_budget_decision_source: ContextBudgetDecision["source"];
  context_budget_decision_input_tokens?: number;
  context_budget_prepared_message_tokens?: number;
  context_budget_system_tokens?: number;
  context_budget_without_file_annotations_status: WithoutFileAnnotationsStatus;
  context_budget_without_file_annotations_message_tokens?: number;
  context_budget_file_annotation_count?: number;
};

/** Missing, invalid or non-finite values are omitted, never reported as zero. */
const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const measureWithoutFileAnnotations = ({
  preparedMessages,
  attachedFileAnnotations,
  preparedMessageTokens,
  countTokens,
}: {
  preparedMessages: readonly ModelMessage[];
  attachedFileAnnotations: unknown;
  preparedMessageTokens: number | undefined;
  countTokens: (text: string) => number;
}): {
  status: WithoutFileAnnotationsStatus;
  messageTokens?: number;
  annotationCount?: number;
} => {
  const notPresent = () => ({
    status: "not_present" as const,
    // Nothing was attached, so the existing prepared estimate already is the
    // without-annotations size. Do not tokenize the request a second time.
    messageTokens: preparedMessageTokens,
  });
  let annotationCount: number | undefined;
  try {
    if (
      !Array.isArray(attachedFileAnnotations) ||
      attachedFileAnnotations.length === 0
    ) {
      return notPresent();
    }
    // Same target rule as addOpenRouterFileAnnotationsToLastAssistantMessage.
    const index = preparedMessages.findLastIndex(
      (message) => message.role === "assistant",
    );
    if (index < 0) return notPresent();
    const message = preparedMessages[index];
    const providerOptions: unknown = message.providerOptions;
    const openrouter = isRecord(providerOptions)
      ? providerOptions.openrouter
      : undefined;
    // Only the exact array attached for this request; never history metadata.
    if (
      !isRecord(openrouter) ||
      openrouter.annotations !== attachedFileAnnotations
    ) {
      return notPresent();
    }
    annotationCount = finiteCount(attachedFileAnnotations.length);
    const { annotations: _attached, ...remainingOpenRouterOptions } =
      openrouter;
    // Copy on write: the prepared request and its source are never mutated.
    const projection = [...preparedMessages];
    projection[index] = {
      ...message,
      providerOptions: {
        ...(providerOptions as Record<string, unknown>),
        openrouter: remainingOpenRouterOptions,
      },
    } as ModelMessage;
    const serialized = JSON.stringify(projection);
    if (typeof serialized !== "string") {
      return { status: "unavailable", annotationCount };
    }
    // Fixed hard cap; callers cannot raise it.
    if (serialized.length > CONTEXT_BUDGET_DIAGNOSTIC_MAX_CHARS) {
      return { status: "size_cap", annotationCount };
    }
    const messageTokens = finiteCount(countTokens(serialized));
    return messageTokens === undefined
      ? { status: "unavailable", annotationCount }
      : { status: "measured", messageTokens, annotationCount };
  } catch {
    return { status: "unavailable", annotationCount };
  }
};

/** Never throws; the caller's original guard error must remain authoritative. */
export function buildContextBudgetProjectionDiagnostics({
  stepIndex,
  decision,
  preparedMessageTokens,
  systemTokens,
  preparedMessages,
  attachedFileAnnotations,
  countTokens = safeCountTokens,
}: {
  stepIndex?: number;
  decision: ContextBudgetDecision;
  preparedMessageTokens?: number;
  systemTokens?: number;
  preparedMessages: readonly ModelMessage[];
  attachedFileAnnotations?: unknown;
  countTokens?: (text: string) => number;
}): ContextBudgetProjectionDiagnostics {
  const source: ContextBudgetDecision["source"] =
    decision?.source === "durable_check" || decision?.source === "rolling_check"
      ? decision.source
      : "not_evaluated";
  const decisionInputTokens =
    source !== "not_evaluated"
      ? finiteCount((decision as { inputTokens?: unknown }).inputTokens)
      : undefined;
  const preparedTokens = finiteCount(preparedMessageTokens);
  const withoutAnnotations = measureWithoutFileAnnotations({
    preparedMessages,
    attachedFileAnnotations,
    preparedMessageTokens: preparedTokens,
    countTokens,
  });
  const withoutAnnotationTokens =
    withoutAnnotations.status === "measured" ||
    withoutAnnotations.status === "not_present"
      ? finiteCount(withoutAnnotations.messageTokens)
      : undefined;
  const step = finiteCount(stepIndex);
  const system = finiteCount(systemTokens);

  return {
    context_budget_projection_diagnostic_version:
      CONTEXT_BUDGET_PROJECTION_DIAGNOSTIC_VERSION,
    ...(step !== undefined && { context_budget_step_index: step }),
    context_budget_decision_source: source,
    ...(decisionInputTokens !== undefined && {
      context_budget_decision_input_tokens: decisionInputTokens,
    }),
    ...(preparedTokens !== undefined && {
      context_budget_prepared_message_tokens: preparedTokens,
    }),
    ...(system !== undefined && { context_budget_system_tokens: system }),
    context_budget_without_file_annotations_status: withoutAnnotations.status,
    ...(withoutAnnotationTokens !== undefined && {
      context_budget_without_file_annotations_message_tokens:
        withoutAnnotationTokens,
    }),
    ...(withoutAnnotations.annotationCount !== undefined && {
      context_budget_file_annotation_count: withoutAnnotations.annotationCount,
    }),
  };
}
