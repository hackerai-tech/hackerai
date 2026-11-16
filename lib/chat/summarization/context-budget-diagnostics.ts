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
} & ContextBudgetAnnotationImageDiagnostics;

/**
 * Independent group: how much of the attached annotation batch is image URL
 * metadata (`type: "image_url"` content parts). Counts are aggregate only;
 * `url_chars` is UTF-16 code units, not network bytes or model tokens.
 */
export const CONTEXT_BUDGET_ANNOTATION_IMAGE_DIAGNOSTIC_VERSION = 1;

/** Fixed shared bounds across the whole attached batch, not per annotation. */
export const CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS = 128;
export const CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_CONTENT_PARTS = 2048;
export const CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_URL_CHARS = 5 * 1024 * 1024;

export type AnnotationImageStatus =
  "measured" | "not_present" | "size_cap" | "unavailable";

export type ContextBudgetAnnotationImageDiagnostics = {
  context_budget_annotation_image_diagnostic_version: typeof CONTEXT_BUDGET_ANNOTATION_IMAGE_DIAGNOSTIC_VERSION;
  context_budget_annotation_image_status: AnnotationImageStatus;
  /** Present only when status is `measured`; partial scans are never reported. */
  context_budget_annotation_image_part_count?: number;
  context_budget_annotation_image_url_chars?: number;
};

/** Missing, invalid or non-finite values are omitted, never reported as zero. */
const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Same target rule as addOpenRouterFileAnnotationsToLastAssistantMessage, and
 * only the exact array attached for this request; never history metadata.
 * May throw on hostile getters; callers own their best-effort boundary.
 */
const findAttachedAnnotationTarget = (
  preparedMessages: readonly ModelMessage[],
  attachedFileAnnotations: unknown,
) => {
  if (
    !Array.isArray(attachedFileAnnotations) ||
    attachedFileAnnotations.length === 0
  ) {
    return undefined;
  }
  const index = preparedMessages.findLastIndex(
    (message) => message.role === "assistant",
  );
  if (index < 0) return undefined;
  const message = preparedMessages[index];
  const providerOptions: unknown = message.providerOptions;
  const openrouter = isRecord(providerOptions)
    ? providerOptions.openrouter
    : undefined;
  if (
    !isRecord(openrouter) ||
    openrouter.annotations !== attachedFileAnnotations
  ) {
    return undefined;
  }
  return {
    annotations: attachedFileAnnotations as readonly unknown[],
    index,
    message,
    providerOptions: providerOptions as Record<string, unknown>,
    openrouter,
  };
};

/**
 * Reads only structural fields and string lengths (O(1)); never reads text
 * content, decodes, downloads, serializes or tokenizes anything. Any shape it
 * does not recognize makes the whole result unavailable rather than a zero.
 */
const measureAnnotationImages = (
  preparedMessages: readonly ModelMessage[],
  attachedFileAnnotations: unknown,
): {
  status: AnnotationImageStatus;
  partCount?: number;
  urlChars?: number;
} => {
  try {
    const target = findAttachedAnnotationTarget(
      preparedMessages,
      attachedFileAnnotations,
    );
    if (!target) return { status: "not_present" };
    const { annotations } = target;
    const annotationCount = finiteCount(annotations.length);
    if (annotationCount === undefined) return { status: "unavailable" };
    if (annotationCount > CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS) {
      return { status: "size_cap" };
    }
    let scannedParts = 0;
    let partCount = 0;
    let urlChars = 0;
    for (let a = 0; a < annotationCount; a++) {
      const annotation = annotations[a];
      if (!isRecord(annotation) || annotation.type !== "file") {
        return { status: "unavailable" };
      }
      const file = annotation.file;
      if (!isRecord(file)) return { status: "unavailable" };
      const content = file.content;
      // The provider schema makes content optional: absent means no parts.
      if (content === undefined) continue;
      if (!Array.isArray(content)) return { status: "unavailable" };
      const contentLength = finiteCount(content.length);
      if (contentLength === undefined) return { status: "unavailable" };
      if (
        contentLength >
        CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_CONTENT_PARTS - scannedParts
      ) {
        return { status: "size_cap" };
      }
      scannedParts += contentLength;
      for (let p = 0; p < contentLength; p++) {
        const part: unknown = content[p];
        if (!isRecord(part)) return { status: "unavailable" };
        const type = part.type;
        if (type === "text") continue;
        if (type !== "image_url") return { status: "unavailable" };
        const imageUrl = part.image_url;
        const url = isRecord(imageUrl) ? imageUrl.url : undefined;
        if (typeof url !== "string") return { status: "unavailable" };
        if (
          url.length >
          CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_URL_CHARS - urlChars
        ) {
          return { status: "size_cap" };
        }
        urlChars += url.length;
        partCount += 1;
      }
    }
    const finalPartCount = finiteCount(partCount);
    const finalUrlChars = finiteCount(urlChars);
    return finalPartCount === undefined || finalUrlChars === undefined
      ? { status: "unavailable" }
      : {
          status: "measured",
          partCount: finalPartCount,
          urlChars: finalUrlChars,
        };
  } catch {
    return { status: "unavailable" };
  }
};

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
    const target = findAttachedAnnotationTarget(
      preparedMessages,
      attachedFileAnnotations,
    );
    if (!target) return notPresent();
    const { index, message, providerOptions, openrouter } = target;
    annotationCount = finiteCount(target.annotations.length);
    const { annotations: _attached, ...remainingOpenRouterOptions } =
      openrouter;
    // Copy on write: the prepared request and its source are never mutated.
    const projection = [...preparedMessages];
    projection[index] = {
      ...message,
      providerOptions: {
        ...providerOptions,
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
  const images = measureAnnotationImages(
    preparedMessages,
    attachedFileAnnotations,
  );

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
    context_budget_annotation_image_diagnostic_version:
      CONTEXT_BUDGET_ANNOTATION_IMAGE_DIAGNOSTIC_VERSION,
    context_budget_annotation_image_status: images.status,
    ...(images.status === "measured" &&
      images.partCount !== undefined &&
      images.urlChars !== undefined && {
        context_budget_annotation_image_part_count: images.partCount,
        context_budget_annotation_image_url_chars: images.urlChars,
      }),
  };
}
