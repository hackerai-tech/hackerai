import type { ModelMessage } from "ai";
import { safeCountTokens } from "@/lib/token-utils";

/**
 * Failure-only projection breakdown for `agent_context_budget_exceeded`.
 *
 * The final send guard measures the current prepared request, while the
 * compaction decision for the same step may have measured an earlier
 * projection. These fields compare the two and isolate the attached OpenRouter
 * file annotations without logging content, hashes, names or URLs.
 *
 * The runner's route-scoped orphaned-annotation policy lives beside these
 * scans and reuses their fixed bounds; it does not change any field here.
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
} & ContextBudgetAnnotationImageDiagnostics &
  ContextBudgetPreparedPdfDiagnostics;

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

/**
 * Independent group, emitted only with an exact attached annotation batch:
 * whether the same prepared request still carries original PDF file parts
 * (`type: "file"`, `mediaType: "application/pdf"`) in user content. A positive
 * count shows presence only; it does not prove the PDF matches an annotation.
 */
export const CONTEXT_BUDGET_PREPARED_PDF_DIAGNOSTIC_VERSION = 1;

/** Fixed shared bounds across the whole prepared request. */
export const CONTEXT_BUDGET_PREPARED_PDF_MAX_MESSAGES = 1024;
export const CONTEXT_BUDGET_PREPARED_PDF_MAX_USER_PARTS = 2048;

export type PreparedPdfStatus = "measured" | "size_cap" | "unavailable";

export type ContextBudgetPreparedPdfDiagnostics = {
  context_budget_prepared_pdf_diagnostic_version?: typeof CONTEXT_BUDGET_PREPARED_PDF_DIAGNOSTIC_VERSION;
  context_budget_prepared_pdf_status?: PreparedPdfStatus;
  /** Present only when status is `measured`; zero is a complete scan. */
  context_budget_prepared_pdf_part_count?: number;
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

const MODEL_MESSAGE_ROLES_WITHOUT_USER_INPUT = new Set<unknown>([
  "system",
  "assistant",
  "tool",
]);

const PDF_MEDIA_TYPE = "application/pdf";

/**
 * Reads only roles, part types and media types; never file data, names, URLs
 * or text. Any unrecognized shape is unavailable so it never reports a false
 * zero. The fixed part budget also bounds the count.
 */
const measurePreparedPdfParts = (
  preparedMessages: readonly ModelMessage[],
):
  | { status: "measured"; partCount: number }
  | { status: "size_cap" | "unavailable" } => {
  try {
    const messageCount = finiteCount(preparedMessages.length);
    if (messageCount === undefined) return { status: "unavailable" };
    if (messageCount > CONTEXT_BUDGET_PREPARED_PDF_MAX_MESSAGES) {
      return { status: "size_cap" };
    }
    let scannedParts = 0;
    let partCount = 0;
    for (let m = 0; m < messageCount; m++) {
      const message: unknown = preparedMessages[m];
      if (!isRecord(message)) return { status: "unavailable" };
      const role = message.role;
      if (MODEL_MESSAGE_ROLES_WITHOUT_USER_INPUT.has(role)) continue;
      if (role !== "user") return { status: "unavailable" };
      const content = message.content;
      if (typeof content === "string") continue;
      if (!Array.isArray(content)) return { status: "unavailable" };
      const contentLength = finiteCount(content.length);
      if (contentLength === undefined) return { status: "unavailable" };
      if (
        contentLength >
        CONTEXT_BUDGET_PREPARED_PDF_MAX_USER_PARTS - scannedParts
      ) {
        return { status: "size_cap" };
      }
      scannedParts += contentLength;
      for (let p = 0; p < contentLength; p++) {
        const part: unknown = content[p];
        if (!isRecord(part)) return { status: "unavailable" };
        const type = part.type;
        if (type === "text" || type === "image") continue;
        if (type !== "file") return { status: "unavailable" };
        const mediaType = part.mediaType;
        if (typeof mediaType !== "string") return { status: "unavailable" };
        // Length first, so a hostile string is never copied by normalization.
        if (
          mediaType.length === PDF_MEDIA_TYPE.length &&
          mediaType.toLowerCase() === PDF_MEDIA_TYPE
        ) {
          partCount += 1;
        }
      }
    }
    return { status: "measured", partCount };
  } catch {
    return { status: "unavailable" };
  }
};

/**
 * Media prefixes the OpenRouter provider converts to a non-file wire part
 * (`image_url`, `video_url`, `input_audio`). Tool `file-data` audio becomes a
 * file for unsupported formats, so tool output never treats audio as safe.
 */
const NON_FILE_USER_MEDIA_PREFIXES = ["image/", "video/", "audio/"] as const;
const NON_FILE_TOOL_MEDIA_PREFIXES = ["image/", "video/"] as const;

const hasMediaPrefix = (mediaType: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => mediaType.startsWith(prefix));

/** Tool `json`/`text` outputs are serialized to strings, never wire files. */
const STRING_TOOL_OUTPUT_TYPES = new Set<unknown>([
  "text",
  "error-text",
  "json",
  "error-json",
  "execution-denied",
]);

/** Tool content items the provider sends as `image_url` or text. */
const NON_FILE_TOOL_CONTENT_TYPES = new Set<unknown>([
  "text",
  "image-data",
  "image-url",
  "image-file-id",
  "file-id",
  "custom",
]);

/**
 * True only when a complete scan proves the request can send no wire `file`
 * part an annotation could belong to; a possible original, unknown shape or
 * exceeded bound is false. Unlike the user-PDF diagnostic, declared PDF media
 * types are not trusted: a data URL in user content replaces the declared
 * type, so only binary data with a non-file media prefix proves a non-file
 * user part. Reads roles, part types, media types and whether data is binary;
 * never text, bytes or URLs. Reuses the user-PDF diagnostic's fixed bounds,
 * with one part budget across user parts, tool results and tool content.
 * Assistant content is skipped: the provider sends no file from it.
 */
const provesNoWireFile = (messages: readonly ModelMessage[]): boolean => {
  const messageCount = finiteCount(messages.length);
  if (
    messageCount === undefined ||
    messageCount > CONTEXT_BUDGET_PREPARED_PDF_MAX_MESSAGES
  ) {
    return false;
  }
  let remainingParts = CONTEXT_BUDGET_PREPARED_PDF_MAX_USER_PARTS;
  const takeParts = (value: unknown): readonly unknown[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const length = finiteCount(value.length);
    if (length === undefined || length > remainingParts) return undefined;
    remainingParts -= length;
    return value;
  };
  for (let m = 0; m < messageCount; m++) {
    const message: unknown = messages[m];
    if (!isRecord(message)) return false;
    const role = message.role;
    if (role === "system" || role === "assistant") continue;
    if (role === "user" && typeof message.content === "string") continue;
    if (role !== "user" && role !== "tool") return false;
    const parts = takeParts(message.content);
    if (!parts) return false;
    for (let p = 0; p < parts.length; p++) {
      const part: unknown = parts[p];
      if (!isRecord(part)) return false;
      const type = part.type;
      if (role === "user") {
        if (type === "text") continue;
        if (type !== "image" && type !== "file") return false;
        // The SDK defaults an untyped binary image part to `image/*`.
        const mediaType =
          type === "image" && part.mediaType === undefined
            ? "image/*"
            : part.mediaType;
        const data = type === "image" ? part.image : part.data;
        if (
          typeof mediaType !== "string" ||
          !ArrayBuffer.isView(data) ||
          !hasMediaPrefix(mediaType, NON_FILE_USER_MEDIA_PREFIXES)
        ) {
          return false;
        }
        continue;
      }
      if (type === "tool-approval-response") continue;
      if (type !== "tool-result") return false;
      const output = part.output;
      if (!isRecord(output)) return false;
      if (STRING_TOOL_OUTPUT_TYPES.has(output.type)) continue;
      if (output.type !== "content") return false;
      const items = takeParts(output.value);
      if (!items) return false;
      for (let i = 0; i < items.length; i++) {
        const item: unknown = items[i];
        if (!isRecord(item)) return false;
        if (NON_FILE_TOOL_CONTENT_TYPES.has(item.type)) continue;
        // `file-url` needs URL inspection to rule out; `media` becomes
        // `file-data` with the same media type unless it is an image.
        if (item.type !== "file-data" && item.type !== "media") return false;
        const itemMediaType = item.mediaType;
        if (
          typeof itemMediaType !== "string" ||
          !hasMediaPrefix(itemMediaType, NON_FILE_TOOL_MEDIA_PREFIXES)
        ) {
          return false;
        }
      }
    }
  }
  return true;
};

/**
 * Returns the batch without `type: "file"` entries only when a complete scan
 * proves the request can send no wire file part. Any possible original file,
 * unknown annotation or message shape, or an exceeded bound returns the input
 * batch unchanged. Other entries keep their identity; an emptied batch becomes
 * `undefined`. Never mutates its inputs or throws.
 */
export function omitFileAnnotationsWithoutPossibleOriginal(
  preparedMessages: readonly ModelMessage[],
  annotations: unknown[] | undefined,
): unknown[] | undefined {
  try {
    if (!Array.isArray(annotations)) return annotations;
    const annotationCount = finiteCount(annotations.length);
    if (
      annotationCount === undefined ||
      annotationCount === 0 ||
      annotationCount > CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS
    ) {
      return annotations;
    }
    const retained: unknown[] = [];
    for (let a = 0; a < annotationCount; a++) {
      const annotation: unknown = annotations[a];
      if (!isRecord(annotation) || typeof annotation.type !== "string") {
        return annotations;
      }
      if (annotation.type !== "file") retained.push(annotation);
    }
    if (retained.length === annotationCount) return annotations;
    if (!provesNoWireFile(preparedMessages)) return annotations;
    return retained.length > 0 ? retained : undefined;
  } catch {
    return annotations;
  }
}

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
  // Reuse the exact-batch evidence: annotationCount is set only after the
  // attached array matched, so an unproven batch emits no PDF fields.
  const pdfs =
    (withoutAnnotations.annotationCount ?? 0) > 0
      ? measurePreparedPdfParts(preparedMessages)
      : undefined;

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
    ...(pdfs && {
      context_budget_prepared_pdf_diagnostic_version:
        CONTEXT_BUDGET_PREPARED_PDF_DIAGNOSTIC_VERSION,
      context_budget_prepared_pdf_status: pdfs.status,
      ...(pdfs.status === "measured" && {
        context_budget_prepared_pdf_part_count: pdfs.partCount,
      }),
    }),
  };
}
