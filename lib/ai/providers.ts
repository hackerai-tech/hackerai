import { customProvider } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ChatMode, SelectedModel } from "@/types/chat";
import { openrouterAttributionHeaders } from "@/lib/ai/openrouter-attribution";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isXaiModelSlug = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().startsWith("x-ai/");

const isGrok46ModelSlug = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().startsWith("x-ai/grok-4.6");

const isKimiModelSlug = (value: unknown): boolean =>
  typeof value === "string" &&
  value.toLowerCase().startsWith("moonshotai/kimi-");

const requestCanRouteToXai = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (isXaiModelSlug(body.model)) return true;
  return Array.isArray(body.models) && body.models.some(isXaiModelSlug);
};

const requestCanRouteToKimi = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (isKimiModelSlug(body.model)) return true;
  return Array.isArray(body.models) && body.models.some(isKimiModelSlug);
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const takePendingToolCallId = (
  pendingToolCallIds: string[],
  requestedId: unknown,
): string | undefined => {
  const toolCallId = nonEmptyString(requestedId);
  if (toolCallId) {
    const matchingIndex = pendingToolCallIds.indexOf(toolCallId);
    if (matchingIndex >= 0) {
      pendingToolCallIds.splice(matchingIndex, 1);
      return toolCallId;
    }
    return undefined;
  }
  return pendingToolCallIds.shift();
};

const normalizeKimiChatToolResults = (
  messages: unknown[],
): { messages: unknown[]; changed: boolean } => {
  const pendingToolCallIds: string[] = [];
  let changed = false;
  const normalized: unknown[] = [];

  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      normalized.push(message);
      return;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      let messageChanged = false;
      const toolCalls = message.tool_calls.map((toolCall, toolCallIndex) => {
        if (!isRecord(toolCall)) return toolCall;
        const existingId = nonEmptyString(toolCall.id);
        const id =
          existingId ?? `hackerai_recovered_${messageIndex}_${toolCallIndex}`;
        const idChanged = id !== toolCall.id;
        if (idChanged) {
          changed = true;
          messageChanged = true;
        }
        pendingToolCallIds.push(id);
        return idChanged ? { ...toolCall, id } : toolCall;
      });
      normalized.push(
        messageChanged ? { ...message, tool_calls: toolCalls } : message,
      );
      return;
    }

    if (message.role === "tool") {
      const toolCallId = takePendingToolCallId(
        pendingToolCallIds,
        message.tool_call_id,
      );
      if (!toolCallId) {
        changed = true;
        return;
      }
      if (toolCallId !== message.tool_call_id) {
        changed = true;
        normalized.push({ ...message, tool_call_id: toolCallId });
        return;
      }
    }

    normalized.push(message);
  });

  return { messages: changed ? normalized : messages, changed };
};

const normalizeKimiResponsesToolResults = (
  input: unknown[],
): { input: unknown[]; changed: boolean } => {
  const pendingToolCallIds: string[] = [];
  let changed = false;
  const normalized: unknown[] = [];

  input.forEach((item, itemIndex) => {
    if (!isRecord(item)) {
      normalized.push(item);
      return;
    }

    if (item.type === "function_call") {
      const existingId = nonEmptyString(item.call_id);
      const callId = existingId ?? `hackerai_recovered_${itemIndex}`;
      const idChanged = callId !== item.call_id;
      if (idChanged) changed = true;
      pendingToolCallIds.push(callId);
      normalized.push(idChanged ? { ...item, call_id: callId } : item);
      return;
    }

    if (item.type === "function_call_output") {
      const callId = takePendingToolCallId(pendingToolCallIds, item.call_id);
      if (!callId) {
        changed = true;
        return;
      }
      if (callId !== item.call_id) {
        changed = true;
        normalized.push({ ...item, call_id: callId });
        return;
      }
    }

    normalized.push(item);
  });

  return { input: changed ? normalized : input, changed };
};

export const normalizeOpenRouterRequestForKimi = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body) || !requestCanRouteToKimi(body)) {
    return { body, changed: false };
  }

  const chatResult = Array.isArray(body.messages)
    ? normalizeKimiChatToolResults(body.messages)
    : undefined;
  const responsesResult = Array.isArray(body.input)
    ? normalizeKimiResponsesToolResults(body.input)
    : undefined;
  if (!chatResult?.changed && !responsesResult?.changed) {
    return { body, changed: false };
  }

  return {
    body: {
      ...body,
      ...(chatResult?.changed ? { messages: chatResult.messages } : {}),
      ...(responsesResult?.changed ? { input: responsesResult.input } : {}),
    },
    changed: true,
  };
};

const hasOwnEncryptedContent = (value: unknown): boolean =>
  isRecord(value) && Object.hasOwn(value, "encrypted_content");

// OpenRouter 2.10 uses this shape for provider-private reasoning blobs.
const isEncryptedReasoningDetail = (value: unknown): boolean =>
  isRecord(value) &&
  (hasOwnEncryptedContent(value) || value.type === "reasoning.encrypted");

const stripEncryptedContent = (
  value: unknown,
  inReasoningDetails = false,
): { value: unknown; changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const cleaned: unknown[] = [];

    for (const item of value) {
      if (inReasoningDetails && isEncryptedReasoningDetail(item)) {
        changed = true;
        continue;
      }
      const result = stripEncryptedContent(item, inReasoningDetails);
      changed ||= result.changed;
      cleaned.push(result.value);
    }

    return changed ? { value: cleaned, changed } : { value, changed: false };
  }

  if (!isRecord(value)) {
    return { value, changed: false };
  }

  let changed = false;
  const cleaned: Record<string, unknown> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (inReasoningDetails && key === "encrypted_content") {
      changed = true;
      continue;
    }

    const nextInReasoningDetails =
      inReasoningDetails || key === "reasoning_details";
    const result = stripEncryptedContent(entryValue, nextInReasoningDetails);
    changed ||= result.changed;

    if (
      key === "reasoning_details" &&
      Array.isArray(result.value) &&
      result.value.length === 0
    ) {
      changed = true;
      continue;
    }

    cleaned[key] = result.value;
  }

  return changed ? { value: cleaned, changed } : { value, changed: false };
};

export const sanitizeOpenRouterEncryptedReasoning = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body)) {
    return { body, changed: false };
  }

  const messagesResult = Array.isArray(body.messages)
    ? stripEncryptedContent(body.messages)
    : undefined;
  const inputResult = Array.isArray(body.input)
    ? stripEncryptedContent(body.input)
    : undefined;

  if (!messagesResult?.changed && !inputResult?.changed) {
    return { body, changed: false };
  }

  return {
    body: {
      ...body,
      ...(messagesResult?.changed ? { messages: messagesResult.value } : {}),
      ...(inputResult?.changed ? { input: inputResult.value } : {}),
    },
    changed: true,
  };
};

export const makeOpenRouterToolChoiceCompatibleWithXaiReasoning = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (
    !isRecord(body) ||
    !requestCanRouteToXai(body) ||
    !isRecord(body.reasoning) ||
    body.reasoning.enabled !== true ||
    body.tool_choice == null ||
    body.tool_choice === "auto" ||
    body.tool_choice === "none"
  ) {
    return { body, changed: false };
  }

  if (!isGrok46ModelSlug(body.model)) {
    return {
      body: {
        ...body,
        reasoning: { ...body.reasoning, enabled: false },
      },
      changed: true,
    };
  }

  const nonXaiFallbackModels = Array.isArray(body.models)
    ? body.models.filter(
        (model): model is string =>
          typeof model === "string" && !isXaiModelSlug(model),
      )
    : [];

  // Grok 4.6 requires reasoning, while xAI reasoning does not accept a forced
  // tool choice. Preserve both behaviors by routing this single request to an
  // existing non-xAI fallback. When no compatible route exists, keep Grok's
  // mandatory reasoning and relax only the forced tool choice.
  const [fallbackModel, ...remainingFallbackModels] = nonXaiFallbackModels;
  if (!fallbackModel) {
    return {
      body: { ...body, tool_choice: "auto" },
      changed: true,
    };
  }

  const { models: _models, ...bodyWithoutModels } = body;
  return {
    body: {
      ...bodyWithoutModels,
      model: fallbackModel,
      ...(remainingFallbackModels.length > 0 && {
        models: remainingFallbackModels,
      }),
    },
    changed: true,
  };
};

const patchKimiReasoningToolCalls = (
  body: unknown,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body)) return { body, changed: false };
  if (
    !Array.isArray(body.messages) ||
    !isRecord(body.reasoning) ||
    body.reasoning.enabled !== true
  ) {
    return { body, changed: false };
  }

  let changed = false;
  const messages = body.messages.map((message) => {
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      !message.reasoning
    ) {
      changed = true;
      return { ...message, reasoning: "." };
    }
    return message;
  });

  return changed
    ? { body: { ...body, messages }, changed: true }
    : { body, changed: false };
};

const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Metadata";

const withOpenRouterMetadataHeader = (
  headers: HeadersInit | undefined,
): Headers => {
  const nextHeaders = new Headers(headers);
  if (!nextHeaders.has(OPENROUTER_METADATA_HEADER)) {
    nextHeaders.set(OPENROUTER_METADATA_HEADER, "enabled");
  }
  return nextHeaders;
};

export const PDF_PARSER_ENGINE_HEADER =
  "x-hackerai-openrouter-pdf-parser-engine";
export const PDF_PARSER_RECOVERY_HEADER =
  "x-hackerai-openrouter-pdf-parser-recovery";
export const MALFORMED_PDF_USER_RESPONSE =
  "This attachment isn’t a valid PDF; re-export or re-upload it.";

const PDF_PARSER_RATE_LIMIT_ERROR =
  "The document parsing engine is currently rate limited. Please retry shortly.";
const PDF_PARSER_INVALID_DOCUMENT_ERROR =
  "The file could not be read as a valid document. It may be corrupt, truncated, or not actually a PDF.";
const SANDBOX_PDF_RECOVERY_INSTRUCTION = `The provider PDF parsers could not read the attached PDF. Inspect the corresponding local_path in the sandbox using terminal or PDF tools. If sandbox tools also cannot open it as a valid PDF, respond exactly: “${MALFORMED_PDF_USER_RESPONSE}” Treat this as a user-correctable attachment issue, not an infrastructure failure.`;

type PdfParserFailure = "rate_limited" | "invalid_document" | "generic_parse";

const classifyPdfParserFailure = async (
  response: Response,
): Promise<PdfParserFailure | undefined> => {
  if (response.ok) return undefined;

  try {
    const responseText = await response.clone().text();
    if (responseText.includes(PDF_PARSER_RATE_LIMIT_ERROR)) {
      return "rate_limited";
    }
    if (responseText.includes(PDF_PARSER_INVALID_DOCUMENT_ERROR)) {
      return "invalid_document";
    }
    if (/failed to parse\b/i.test(responseText)) {
      return "generic_parse";
    }
  } catch {
    // Preserve the original provider response when its body cannot be read.
  }
  return undefined;
};

const replacePdfParserEngine = (
  body: unknown,
  fromEngine: "mistral-ocr" | "cloudflare-ai",
  toEngine: "cloudflare-ai",
): { body: unknown; changed: boolean } => {
  if (!isRecord(body) || !Array.isArray(body.plugins)) {
    return { body, changed: false };
  }

  let changed = false;
  const plugins = body.plugins.map((plugin) => {
    if (
      !isRecord(plugin) ||
      plugin.id !== "file-parser" ||
      !isRecord(plugin.pdf) ||
      plugin.pdf.engine !== fromEngine
    ) {
      return plugin;
    }
    changed = true;
    return { ...plugin, pdf: { ...plugin.pdf, engine: toEngine } };
  });

  return changed
    ? { body: { ...body, plugins }, changed: true }
    : { body, changed: false };
};

const requestUsesPdfParserEngine = (
  body: unknown,
  engine: "mistral-ocr" | "cloudflare-ai",
): boolean =>
  isRecord(body) &&
  Array.isArray(body.plugins) &&
  body.plugins.some(
    (plugin) =>
      isRecord(plugin) &&
      plugin.id === "file-parser" &&
      isRecord(plugin.pdf) &&
      plugin.pdf.engine === engine,
  );

const getAttributeFromAttachmentTag = (
  tag: string,
  attribute: string,
): string | undefined =>
  new RegExp(`\\b${attribute}="([^"]+)"`, "i").exec(tag)?.[1];

const collectSandboxAttachmentFilenames = (
  messages: unknown[],
): Set<string> => {
  const filenames = new Set<string>();
  const collectFromText = (text: string) => {
    for (const match of text.matchAll(/<attachment\b[^>]*>/gi)) {
      const tag = match[0];
      const localPath = getAttributeFromAttachmentTag(tag, "local_path");
      const filename = getAttributeFromAttachmentTag(tag, "filename");
      if (localPath?.startsWith("/home/user/upload/") && filename) {
        filenames.add(filename);
      }
    }
  };

  messages.forEach((message) => {
    if (!isRecord(message)) return;
    if (typeof message.content === "string") {
      collectFromText(message.content);
      return;
    }
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part) => {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        collectFromText(part.text);
      }
    });
  });

  return filenames;
};

const isPdfRequestPart = (part: unknown): boolean => {
  if (!isRecord(part) || part.type !== "file" || !isRecord(part.file)) {
    return false;
  }
  const filename = part.file.filename;
  const fileData = part.file.file_data;
  return (
    (typeof filename === "string" && filename.toLowerCase().endsWith(".pdf")) ||
    (typeof fileData === "string" &&
      fileData.toLowerCase().startsWith("data:application/pdf"))
  );
};

const isFileRequestPart = (part: unknown): boolean =>
  isRecord(part) && part.type === "file";

const getFileRequestFilename = (part: unknown): string | undefined =>
  isRecord(part) && isRecord(part.file)
    ? nonEmptyString(part.file.filename)
    : undefined;

const GENERIC_SANDBOX_ATTACHMENT_RECOVERY_INSTRUCTION =
  "Use the corresponding local_path values and inspect the files with sandbox tools instead of asking the provider to parse them again.";

// OpenRouter enforces this against the complete serialized HTTP body, not
// individual messages, attachments, or token estimates.
export const OPENROUTER_REQUEST_MAX_BYTES = 5 * 1024 * 1024;

const OPENROUTER_REQUEST_SIZE_GUARD_HEADER =
  "x-hackerai-openrouter-request-size-guard";
const OPENROUTER_REQUEST_BYTES_BEFORE_HEADER =
  "x-hackerai-openrouter-request-bytes-before";
const OPENROUTER_REQUEST_BYTES_AFTER_HEADER =
  "x-hackerai-openrouter-request-bytes-after";
const OPENROUTER_REQUEST_LIMIT_BYTES_HEADER =
  "x-hackerai-openrouter-request-limit-bytes";

const TOOL_MEDIA_REQUEST_RECOVERY_INSTRUCTION =
  "Inline media from this tool result was omitted because the serialized provider request exceeded its byte limit. Use the original user attachment if it is still available; otherwise create a smaller copy and view it again.";

const getUtf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

type OpenRouterRequestSizeDiagnostics = {
  messageCount: number;
  toolMessageCount: number;
  providerFilePartCount: number;
  inlineToolMediaPartCount: number;
  inlineToolMediaBytes: number;
};

const isInlineDataUrl = (value: unknown): value is string =>
  typeof value === "string" && /^data:[^,]+,/i.test(value);

const isInlineToolMediaPart = (part: unknown): boolean => {
  if (!isRecord(part)) return false;
  if (part.type === "image_url" && isRecord(part.image_url)) {
    return isInlineDataUrl(part.image_url.url);
  }
  if (part.type === "video_url" && isRecord(part.video_url)) {
    return isInlineDataUrl(part.video_url.url);
  }
  if (part.type === "file" && isRecord(part.file)) {
    return isInlineDataUrl(part.file.file_data);
  }
  return (
    part.type === "input_audio" &&
    isRecord(part.input_audio) &&
    typeof part.input_audio.data === "string"
  );
};

const getOpenRouterRequestSizeDiagnostics = (
  body: unknown,
): OpenRouterRequestSizeDiagnostics => {
  const diagnostics: OpenRouterRequestSizeDiagnostics = {
    messageCount: 0,
    toolMessageCount: 0,
    providerFilePartCount: 0,
    inlineToolMediaPartCount: 0,
    inlineToolMediaBytes: 0,
  };
  if (!isRecord(body) || !Array.isArray(body.messages)) return diagnostics;

  diagnostics.messageCount = body.messages.length;
  body.messages.forEach((message) => {
    if (!isRecord(message)) return;
    if (message.role === "tool") diagnostics.toolMessageCount += 1;
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part) => {
      if (isFileRequestPart(part)) diagnostics.providerFilePartCount += 1;
      if (message.role !== "tool" || !isInlineToolMediaPart(part)) return;
      diagnostics.inlineToolMediaPartCount += 1;
      diagnostics.inlineToolMediaBytes += getUtf8ByteLength(
        JSON.stringify(part),
      );
    });
  });
  return diagnostics;
};

const createToolMediaRequestRecoveryBody = (
  body: unknown,
  maxBytes: number,
): { body: unknown; changed: boolean; removedPartCount: number } => {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { body, changed: false, removedPartCount: 0 };
  }

  const messages = body.messages.map((message) =>
    isRecord(message) && Array.isArray(message.content)
      ? { ...message, content: [...message.content] }
      : message,
  );
  const candidates: Array<{
    messageIndex: number;
    contentIndex: number;
    bytes: number;
  }> = [];

  messages.forEach((message, messageIndex) => {
    if (
      !isRecord(message) ||
      message.role !== "tool" ||
      !Array.isArray(message.content)
    ) {
      return;
    }
    message.content.forEach((part, contentIndex) => {
      if (!isInlineToolMediaPart(part)) return;
      candidates.push({
        messageIndex,
        contentIndex,
        bytes: getUtf8ByteLength(JSON.stringify(part)),
      });
    });
  });

  // Remove the largest inline tool payloads first so recovery loses as little
  // visual context as possible. User-authored media is deliberately untouched.
  candidates.sort(
    (left, right) =>
      right.bytes - left.bytes || left.messageIndex - right.messageIndex,
  );

  let removedPartCount = 0;
  let recoveredBody: unknown = { ...body, messages };
  for (const candidate of candidates) {
    const message = messages[candidate.messageIndex];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    message.content[candidate.contentIndex] = {
      type: "text",
      text: TOOL_MEDIA_REQUEST_RECOVERY_INSTRUCTION,
    };
    removedPartCount += 1;
    recoveredBody = { ...body, messages };
    if (getUtf8ByteLength(JSON.stringify(recoveredBody)) <= maxBytes) break;
  }

  return {
    body: recoveredBody,
    changed: removedPartCount > 0,
    removedPartCount,
  };
};

const createSandboxPdfRecoveryBody = (
  body: unknown,
  removeAllFileParts = false,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { body, changed: false };
  }
  if (collectSandboxAttachmentFilenames(body.messages).size === 0) {
    return { body, changed: false };
  }

  let removedFilePart = false;
  let lastUserMessageIndex = -1;
  const messages = body.messages.map((message, index) => {
    if (!isRecord(message)) return message;
    if (message.role === "user") lastUserMessageIndex = index;
    if (!Array.isArray(message.content)) return message;

    // The provider file part does not retain a stable attachment ID. Limit a
    // filename match to the same message and reject duplicate names there.
    const sandboxAttachmentFilenames = collectSandboxAttachmentFilenames([
      message,
    ]);
    const filePartFilenameCounts = new Map<string, number>();
    message.content.forEach((part) => {
      if (!isFileRequestPart(part)) return;
      const filename = getFileRequestFilename(part);
      if (!filename) return;
      filePartFilenameCounts.set(
        filename,
        (filePartFilenameCounts.get(filename) ?? 0) + 1,
      );
    });

    const content = message.content.filter((part) => {
      const filename = getFileRequestFilename(part);
      const shouldRemove =
        filename !== undefined &&
        sandboxAttachmentFilenames.has(filename) &&
        filePartFilenameCounts.get(filename) === 1 &&
        (removeAllFileParts ? isFileRequestPart(part) : isPdfRequestPart(part));
      removedFilePart ||= shouldRemove;
      return !shouldRemove;
    });
    return content.length === message.content.length
      ? message
      : { ...message, content };
  });

  if (!removedFilePart || lastUserMessageIndex < 0) {
    return { body, changed: false };
  }

  const lastUserMessage = messages[lastUserMessageIndex];
  if (!isRecord(lastUserMessage)) {
    return { body, changed: false };
  }
  const recoveryInstruction = removeAllFileParts
    ? GENERIC_SANDBOX_ATTACHMENT_RECOVERY_INSTRUCTION
    : SANDBOX_PDF_RECOVERY_INSTRUCTION;
  const existingContent = lastUserMessage.content;
  const content = Array.isArray(existingContent)
    ? [...existingContent, { type: "text", text: recoveryInstruction }]
    : [
        ...(typeof existingContent === "string" && existingContent.length > 0
          ? [{ type: "text", text: existingContent }]
          : []),
        { type: "text", text: recoveryInstruction },
      ];
  messages[lastUserMessageIndex] = { ...lastUserMessage, content };

  const plugins = Array.isArray(body.plugins)
    ? body.plugins.filter(
        (plugin) => !isRecord(plugin) || plugin.id !== "file-parser",
      )
    : body.plugins;

  return {
    body: { ...body, messages, ...(plugins ? { plugins } : {}) },
    changed: true,
  };
};

const withPrivateResponseHeader = (
  response: Response,
  name: string,
  value: string,
): Response => {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const logPdfParserRecovery = (
  fromEngine: "mistral-ocr" | "cloudflare-ai" | "unknown",
  toEngine: "cloudflare-ai" | "sandbox",
  reason: PdfParserFailure,
) => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "openrouter_pdf_parser_recovery",
      service: "openrouter",
      environment:
        process.env.TRIGGER_ENV ??
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV ??
        "unknown",
      from_engine: fromEngine,
      to_engine: toEngine,
      reason,
    }),
  );
};

const getOpenRouterRequestLogContext = (
  body: unknown,
): { model?: string; userId?: string } => {
  if (!isRecord(body)) return {};
  const model =
    typeof body.model === "string" &&
    /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(body.model)
      ? body.model
      : undefined;
  const userId =
    typeof body.user === "string" && /^user_[a-z0-9_-]{1,128}$/i.test(body.user)
      ? body.user
      : undefined;
  return { model, userId };
};

const logOpenRouterRequestSizeGuard = ({
  requestId,
  action,
  requestBytesBefore,
  requestBytesAfter,
  model,
  userId,
  diagnostics,
  removedProviderFilePartCount,
  removedToolMediaPartCount,
}: {
  requestId: string;
  action:
    | "sandbox_file_fallback"
    | "tool_media_fallback"
    | "sandbox_file_and_tool_media_fallback"
    | "rejected";
  requestBytesBefore: number;
  requestBytesAfter: number;
  model?: string;
  userId?: string;
  diagnostics: OpenRouterRequestSizeDiagnostics;
  removedProviderFilePartCount: number;
  removedToolMediaPartCount: number;
}) => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "openrouter_request_size_guard",
      service: "openrouter",
      environment:
        process.env.TRIGGER_ENV ??
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV ??
        "unknown",
      request_id: requestId,
      reason: "request_limit_exceeded",
      action,
      model,
      user_id: userId,
      request_bytes_before: requestBytesBefore,
      request_bytes_after: requestBytesAfter,
      limit_bytes: OPENROUTER_REQUEST_MAX_BYTES,
      message_count: diagnostics.messageCount,
      tool_message_count: diagnostics.toolMessageCount,
      provider_file_part_count: diagnostics.providerFilePartCount,
      inline_tool_media_part_count: diagnostics.inlineToolMediaPartCount,
      inline_tool_media_bytes: diagnostics.inlineToolMediaBytes,
      removed_provider_file_part_count: removedProviderFilePartCount,
      removed_tool_media_part_count: removedToolMediaPartCount,
    }),
  );
};

const createOpenRouterRequestTooLargeResponse = (
  requestBytesBefore: number,
  requestBytesAfter: number,
  requestId: string,
): Response =>
  new Response(
    JSON.stringify({
      error: {
        code: "request_too_large",
        message: `OpenRouter request is ${requestBytesAfter} bytes, exceeding the ${OPENROUTER_REQUEST_MAX_BYTES}-byte limit, and no safe request reduction fit within the limit.`,
      },
    }),
    {
      status: 413,
      headers: {
        "content-type": "application/json",
        [OPENROUTER_REQUEST_SIZE_GUARD_HEADER]: "rejected",
        [OPENROUTER_REQUEST_BYTES_BEFORE_HEADER]: String(requestBytesBefore),
        [OPENROUTER_REQUEST_BYTES_AFTER_HEADER]: String(requestBytesAfter),
        [OPENROUTER_REQUEST_LIMIT_BYTES_HEADER]: String(
          OPENROUTER_REQUEST_MAX_BYTES,
        ),
        "x-hackerai-request-id": requestId,
      },
    },
  );

const enforceOpenRouterRequestSizeLimit = (
  init: RequestInit,
): { init: RequestInit; rejection?: Response } => {
  if (typeof init.body !== "string") return { init };

  const requestBytesBefore = getUtf8ByteLength(init.body);
  if (requestBytesBefore <= OPENROUTER_REQUEST_MAX_BYTES) return { init };

  const requestId = globalThis.crypto.randomUUID();
  let fallbackBody: string | undefined;
  let requestContext: { model?: string; userId?: string } = {};
  let diagnostics: OpenRouterRequestSizeDiagnostics = {
    messageCount: 0,
    toolMessageCount: 0,
    providerFilePartCount: 0,
    inlineToolMediaPartCount: 0,
    inlineToolMediaBytes: 0,
  };
  let removedProviderFilePartCount = 0;
  let removedToolMediaPartCount = 0;
  try {
    const parsedBody = JSON.parse(init.body) as unknown;
    requestContext = getOpenRouterRequestLogContext(parsedBody);
    diagnostics = getOpenRouterRequestSizeDiagnostics(parsedBody);

    const sandboxFallback = createSandboxPdfRecoveryBody(parsedBody, true);
    let recoveryBody = sandboxFallback.changed
      ? sandboxFallback.body
      : parsedBody;
    if (sandboxFallback.changed) {
      const afterSandboxDiagnostics =
        getOpenRouterRequestSizeDiagnostics(recoveryBody);
      removedProviderFilePartCount = Math.max(
        0,
        diagnostics.providerFilePartCount -
          afterSandboxDiagnostics.providerFilePartCount,
      );
    }

    if (
      getUtf8ByteLength(JSON.stringify(recoveryBody)) >
      OPENROUTER_REQUEST_MAX_BYTES
    ) {
      const toolMediaFallback = createToolMediaRequestRecoveryBody(
        recoveryBody,
        OPENROUTER_REQUEST_MAX_BYTES,
      );
      if (toolMediaFallback.changed) {
        recoveryBody = toolMediaFallback.body;
        removedToolMediaPartCount = toolMediaFallback.removedPartCount;
      }
    }

    if (sandboxFallback.changed || removedToolMediaPartCount > 0) {
      fallbackBody = JSON.stringify(recoveryBody);
    }
  } catch {
    // Only valid JSON request bodies can use the attachment fallback.
  }

  const requestBytesAfter = fallbackBody
    ? getUtf8ByteLength(fallbackBody)
    : requestBytesBefore;
  if (fallbackBody && requestBytesAfter <= OPENROUTER_REQUEST_MAX_BYTES) {
    const action =
      removedProviderFilePartCount > 0 && removedToolMediaPartCount > 0
        ? "sandbox_file_and_tool_media_fallback"
        : removedToolMediaPartCount > 0
          ? "tool_media_fallback"
          : "sandbox_file_fallback";
    logOpenRouterRequestSizeGuard({
      requestId,
      action,
      requestBytesBefore,
      requestBytesAfter,
      ...requestContext,
      diagnostics,
      removedProviderFilePartCount,
      removedToolMediaPartCount,
    });
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    return { init: { ...init, headers, body: fallbackBody } };
  }

  logOpenRouterRequestSizeGuard({
    requestId,
    action: "rejected",
    requestBytesBefore,
    requestBytesAfter,
    ...requestContext,
    diagnostics,
    removedProviderFilePartCount,
    removedToolMediaPartCount,
  });
  return {
    init,
    rejection: createOpenRouterRequestTooLargeResponse(
      requestBytesBefore,
      requestBytesAfter,
      requestId,
    ),
  };
};

/** Attach response headers to body-stream failures for later attribution. */
export const enrichOpenRouterStreamError = (
  error: unknown,
  responseHeaders: Record<string, string>,
): Error & { responseHeaders: Record<string, string> } => {
  const enriched =
    error instanceof Error
      ? error
      : new Error(
          typeof error === "string" ? error : "OpenRouter stream failed",
        );
  try {
    return Object.assign(enriched, { responseHeaders });
  } catch {
    return Object.assign(new Error(enriched.message, { cause: error }), {
      name: enriched.name,
      responseHeaders,
    });
  }
};

/** Retain response IDs when the response body fails after headers arrived. */
export const attachOpenRouterStreamErrorMetadata = (
  response: Response,
): Response => {
  if (!response.ok || !response.body) return response;

  const reader = response.body.getReader();
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(enrichOpenRouterStreamError(error, responseHeaders));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

// Custom fetch for OpenRouter provider-specific request-body repairs.
//
// - Kimi rejects missing or orphaned tool-result IDs. Repair IDs when the
//   transcript order makes the match deterministic and omit unmatchable output.
// - Kimi requires a `reasoning` field on assistant tool-call messages when
//   reasoning mode is enabled, but the AI SDK does not always include one.
// - OpenRouter pins encrypted reasoning blobs to the endpoint that created
//   them. HackerAI routes across providers between steps, so the visible
//   assistant text remains in the prompt while provider-private blobs are
//   omitted from every request.
// - xAI rejects forced tool choice while reasoning is enabled, and Grok 4.6
//   rejects disabled reasoning. Keep both constraints on Grok 4.6 primary
//   requests by using their existing non-xAI fallback for forced-tool steps.
// - The metadata header opts into OpenRouter routing metadata for attribution.
export const createOpenRouterPatchFetch =
  (fetchImplementation: typeof fetch = globalThis.fetch): typeof fetch =>
  async (url, init) => {
    let nextInit: RequestInit = {
      ...init,
      headers: withOpenRouterMetadataHeader(init?.headers),
    };

    let parsedRequestBody: unknown;

    if (nextInit.body && typeof nextInit.body === "string") {
      try {
        const parsedBody = JSON.parse(nextInit.body) as unknown;
        const kimiNormalized = normalizeOpenRouterRequestForKimi(parsedBody);
        const kimiPatched = patchKimiReasoningToolCalls(kimiNormalized.body);
        const reasoningPatched = sanitizeOpenRouterEncryptedReasoning(
          kimiPatched.body,
        );
        const xaiCompatible =
          makeOpenRouterToolChoiceCompatibleWithXaiReasoning(
            reasoningPatched.body,
          );
        parsedRequestBody = xaiCompatible.body;
        if (
          kimiNormalized.changed ||
          kimiPatched.changed ||
          reasoningPatched.changed ||
          xaiCompatible.changed
        ) {
          nextInit = {
            ...nextInit,
            body: JSON.stringify(xaiCompatible.body),
          };
        }
      } catch {
        // If parsing fails, send the request as-is
      }
    }

    const fetchWithinRequestLimit = async (
      requestInit: RequestInit,
    ): Promise<Response> => {
      const guarded = enforceOpenRouterRequestSizeLimit(requestInit);
      if (guarded.rejection) return guarded.rejection;
      return fetchImplementation(url, guarded.init);
    };

    const initialResponse = await fetchWithinRequestLimit(nextInit);
    const parserFailure = await classifyPdfParserFailure(initialResponse);
    if (!parserFailure) {
      return attachOpenRouterStreamErrorMetadata(initialResponse);
    }

    if (parserFailure === "generic_parse") {
      const sandboxBody = createSandboxPdfRecoveryBody(parsedRequestBody, true);
      if (!sandboxBody.changed) {
        return attachOpenRouterStreamErrorMetadata(initialResponse);
      }

      logPdfParserRecovery("unknown", "sandbox", parserFailure);
      const sandboxResponse = await fetchWithinRequestLimit({
        ...nextInit,
        body: JSON.stringify(sandboxBody.body),
      });
      return attachOpenRouterStreamErrorMetadata(
        withPrivateResponseHeader(
          sandboxResponse,
          PDF_PARSER_RECOVERY_HEADER,
          "sandbox",
        ),
      );
    }

    if (requestUsesPdfParserEngine(parsedRequestBody, "cloudflare-ai")) {
      const sandboxBody = createSandboxPdfRecoveryBody(parsedRequestBody);
      if (!sandboxBody.changed) {
        return attachOpenRouterStreamErrorMetadata(initialResponse);
      }

      logPdfParserRecovery("cloudflare-ai", "sandbox", parserFailure);
      const sandboxResponse = await fetchWithinRequestLimit({
        ...nextInit,
        body: JSON.stringify(sandboxBody.body),
      });
      return attachOpenRouterStreamErrorMetadata(
        withPrivateResponseHeader(
          sandboxResponse,
          PDF_PARSER_RECOVERY_HEADER,
          "sandbox",
        ),
      );
    }

    const cloudflareBody = replacePdfParserEngine(
      parsedRequestBody,
      "mistral-ocr",
      "cloudflare-ai",
    );
    if (!cloudflareBody.changed) {
      return attachOpenRouterStreamErrorMetadata(initialResponse);
    }

    logPdfParserRecovery("mistral-ocr", "cloudflare-ai", parserFailure);
    const cloudflareResponse = await fetchWithinRequestLimit({
      ...nextInit,
      body: JSON.stringify(cloudflareBody.body),
    });
    const cloudflareFailure =
      await classifyPdfParserFailure(cloudflareResponse);
    if (!cloudflareFailure) {
      return attachOpenRouterStreamErrorMetadata(
        withPrivateResponseHeader(
          cloudflareResponse,
          PDF_PARSER_ENGINE_HEADER,
          "cloudflare-ai",
        ),
      );
    }

    const sandboxBody = createSandboxPdfRecoveryBody(cloudflareBody.body);
    if (!sandboxBody.changed) {
      return attachOpenRouterStreamErrorMetadata(cloudflareResponse);
    }

    logPdfParserRecovery("cloudflare-ai", "sandbox", cloudflareFailure);
    const sandboxResponse = await fetchWithinRequestLimit({
      ...nextInit,
      body: JSON.stringify(sandboxBody.body),
    });
    return attachOpenRouterStreamErrorMetadata(
      withPrivateResponseHeader(
        sandboxResponse,
        PDF_PARSER_RECOVERY_HEADER,
        "sandbox",
      ),
    );
  };

const openrouterPatchFetch = createOpenRouterPatchFetch();

const openrouter = createOpenRouter({
  fetch: openrouterPatchFetch,
  headers: openrouterAttributionHeaders,
});

type OpenRouterInstance = typeof openrouter;

export const KIMI_K3_SLUG = "moonshotai/kimi-k3";
export const GLM_5_2_SLUG = "z-ai/glm-5.2";
export const GLM_5_3_SLUG = "z-ai/glm-5.3";
export const GLM_5_3_FLASH_SLUG = "z-ai/glm-5.3-flash";
export const GROK_4_5_SLUG = "x-ai/grok-4.5";
export const GROK_4_6_SLUG = "x-ai/grok-4.6";
export const DEEPSEEK_V4_FLASH_VISION_SLUG =
  "deepseek/deepseek-v4-flash-vision-exp";
export const MINIMAX_M3_SLUG = "minimax/minimax-m3";
// MiniMax is deliberately isolated to the final text-summary recovery. Normal
// image turns route the original pixels through GLM Flash and then DeepSeek
// Vision, so the lossy description hop is paid only when both direct routes fail.
export const AUXILIARY_VISION_SLUG = MINIMAX_M3_SLUG;
export const DEEPSEEK_V4_PRO_SLUG = "deepseek/deepseek-v4-pro";
export const DEEPSEEK_V4_PRO_0813_SLUG = "deepseek/deepseek-v4-pro-0813";
export const DEEPSEEK_V4_FLASH_SLUG = "deepseek/deepseek-v4-flash-0731";
export const DEEPSEEK_V4_FLASH_PREVIOUS_SLUG = "deepseek/deepseek-v4-flash";
const TITLE_GENERATOR_DEEPSEEK_SLUG = "deepseek/deepseek-v4-flash";

export const getOpenRouterProviderRoutingForModel = (
  modelSlug: string,
):
  | { ignore: string[] }
  | { sort: "latency"; data_collection: "deny" }
  | undefined => {
  if (modelSlug === DEEPSEEK_V4_FLASH_PREVIOUS_SLUG) {
    return { ignore: ["novita"] };
  }
  if (modelSlug === GLM_5_3_FLASH_SLUG) {
    return { sort: "latency", data_collection: "deny" };
  }
  return undefined;
};

const buildProviderMap = (
  or: OpenRouterInstance,
  freeAskModelSlug = GLM_5_3_FLASH_SLUG,
  freeAgentModelSlug = GLM_5_3_FLASH_SLUG,
) =>
  ({
    "ask-model": or(GROK_4_6_SLUG),
    "ask-model-free": or(freeAskModelSlug),
    "agent-model": or(GROK_4_6_SLUG),
    "agent-model-free": or(freeAgentModelSlug),
    "model-grok-4.6": or(GROK_4_6_SLUG),
    // Separate internal keys use the same Grok 4.5 provider model while
    // provider reasoning options distinguish Standard from Pro vision.
    "model-grok-4.5": or(GROK_4_5_SLUG),
    "model-grok-4.5-pro": or(GROK_4_5_SLUG),
    "model-grok-4.6-pro": or(GROK_4_6_SLUG),
    "model-deepseek-v4-flash-0731": or(DEEPSEEK_V4_FLASH_SLUG),
    "model-deepseek-v4-pro": or(DEEPSEEK_V4_PRO_SLUG),
    "model-deepseek-v4-pro-0813": or(DEEPSEEK_V4_PRO_0813_SLUG),
    // Keep the persisted Max compatibility key while routing new requests to
    // Kimi K3. Renaming the key would invalidate existing stored selections.
    "model-opus-4.6": or(KIMI_K3_SLUG),
    "model-glm-5.2": or(GLM_5_2_SLUG),
    "model-glm-5.3": or(GLM_5_3_SLUG),
    "model-glm-5.3-flash": or(GLM_5_3_FLASH_SLUG),
    "model-glm-5.3-flash-pro": or(GLM_5_3_FLASH_SLUG),
    "model-glm-5.3-flash-agent": or(GLM_5_3_FLASH_SLUG),
    "model-deepseek-v4-flash-vision": or(DEEPSEEK_V4_FLASH_VISION_SLUG),
    "model-kimi-k3": or(KIMI_K3_SLUG),
    "fallback-agent-model": or(GROK_4_6_SLUG),
    "fallback-ask-model": or(GROK_4_6_SLUG),
    // Titles are a short structured-output task and should never use reasoning.
    "title-generator-model": or(TITLE_GENERATOR_DEEPSEEK_SLUG),
    // Separate text-only, tool-less call used to review one approval-gated
    // action. The reviewer receives serialized evidence rather than images.
    "agent-auto-review-model": or(DEEPSEEK_V4_FLASH_SLUG),
    // Image understanding for text-only routes. The resulting description is
    // injected as untrusted text; this model never becomes the active agent.
    "auxiliary-vision-model": or(AUXILIARY_VISION_SLUG),
  }) as Record<string, any>;

const baseProviders = buildProviderMap(openrouter);

export type ModelName = keyof typeof baseProviders;

export const modelCutoffDates: Partial<Record<ModelName, string>> &
  Record<string, string | undefined> = {
  "ask-model": "August 2026",
  "agent-model": "August 2026",
  "model-grok-4.6": "August 2026",
  "model-grok-4.6-pro": "August 2026",
  "model-deepseek-v4-flash-0731": "July 2026",
  "model-deepseek-v4-pro": "May 2025",
  "model-deepseek-v4-pro-0813": "August 2026",
  "model-opus-4.6": "July 2026",
  "model-glm-5.2": "June 2026",
  "model-glm-5.3-flash": "August 2026",
  "model-glm-5.3-flash-pro": "August 2026",
  "model-glm-5.3-flash-agent": "August 2026",
  "model-deepseek-v4-flash-vision": "August 2026",
  "fallback-agent-model": "August 2026",
  "fallback-ask-model": "August 2026",
  "title-generator-model": "May 2025",
  "agent-auto-review-model": "July 2026",
  "auxiliary-vision-model": "July 2026",
};

export const modelDisplayNames: Record<ModelName, string> &
  Record<string, string> = {
  "ask-model": "Auto, an intelligent model router built by HackerAI",
  "ask-model-free": "Auto, an intelligent model router built by HackerAI",
  "agent-model": "Auto, an intelligent model router built by HackerAI",
  "agent-model-free": "Auto, an intelligent model router built by HackerAI",
  "model-grok-4.6": "xAI Grok 4.6",
  "model-grok-4.5": "xAI Grok 4.5",
  "model-grok-4.5-pro": "xAI Grok 4.5",
  "model-grok-4.6-pro": "xAI Grok 4.6",
  "model-deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731",
  "model-deepseek-v4-pro": "DeepSeek V4 Pro",
  "model-deepseek-v4-pro-0813": "DeepSeek V4 Pro 0813",
  "model-opus-4.6": "Moonshot Kimi K3",
  "model-glm-5.2": "Z.ai GLM 5.2",
  "model-glm-5.3": "Z.ai GLM 5.3",
  "model-glm-5.3-flash": "Z.ai GLM 5.3 Flash",
  "model-glm-5.3-flash-pro": "Z.ai GLM 5.3 Flash",
  "model-glm-5.3-flash-agent": "Z.ai GLM 5.3 Flash",
  "model-deepseek-v4-flash-vision": "DeepSeek V4 Flash Vision",
  "model-kimi-k3": "Moonshot Kimi K3",
  "fallback-agent-model": "Auto, an intelligent model router built by HackerAI",
  "fallback-ask-model": "Auto, an intelligent model router built by HackerAI",
  "title-generator-model": "DeepSeek V4 Flash",
  "agent-auto-review-model": "DeepSeek V4 Flash 0731",
  "auxiliary-vision-model": "Auxiliary vision model",
};

export const getModelDisplayName = (modelName: ModelName): string => {
  return modelDisplayNames[modelName];
};

export const getModelCutoffDate = (
  modelName: ModelName,
): string | undefined => {
  return modelCutoffDates[modelName];
};

export function isAnthropicModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.startsWith("anthropic/") || normalized.includes("claude");
}

/** Returns whether a provider key uses a DeepSeek V4 route. */
export function isDeepSeekModel(modelName: string): boolean {
  return (
    modelName === "agent-auto-review-model" ||
    modelName === "model-deepseek-v4-flash-0731" ||
    modelName === "model-deepseek-v4-pro" ||
    modelName === "model-deepseek-v4-pro-0813"
  );
}

export function isKimiModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized === "model-kimi-k3" ||
    normalized === "model-opus-4.6" ||
    normalized.includes("moonshotai/kimi")
  );
}

function isGrokModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized === "agent-model" ||
    normalized === "ask-model" ||
    normalized === "fallback-agent-model" ||
    normalized === "fallback-ask-model" ||
    normalized === "model-grok-4.6" ||
    normalized === "model-grok-4.5" ||
    normalized === "model-grok-4.5-pro" ||
    normalized === "model-grok-4.6-pro" ||
    normalized.includes("x-ai/") ||
    normalized === "grok-4.5" ||
    normalized === "grok-4.6"
  );
}

export function supportsMultimodalToolResults(modelName?: string): boolean {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase();

  return (
    normalized === "ask-model-free" ||
    normalized === "agent-model-free" ||
    normalized === "model-glm-5.3-flash" ||
    normalized === "model-glm-5.3-flash-pro" ||
    normalized === "model-glm-5.3-flash-agent" ||
    normalized === "model-deepseek-v4-flash-vision" ||
    normalized.includes("z-ai/glm-5.3-flash") ||
    normalized.includes("deepseek-v4-flash-vision") ||
    isKimiModel(normalized) ||
    isGrokModel(normalized) ||
    isAnthropicModel(normalized) ||
    normalized.includes("anthropic/") ||
    normalized.includes("claude") ||
    normalized.includes("openai/") ||
    normalized.includes("gpt-") ||
    normalized.includes("o1") ||
    normalized.includes("o3") ||
    normalized.includes("o4")
  );
}

/**
 * Map a HackerAI tier id to the underlying provider key for a given mode.
 * Returns `null` for `"auto"` (the caller routes to the auto-router model
 * key instead). Standard maps to DeepSeek V4 Flash 0731, Pro to DeepSeek V4
 * Pro 0813, and Max to Grok 4.6 in both modes; media-aware promotion happens
 * in `selectModel`.
 */
export function resolveTierToProviderKey(
  tier: SelectedModel,
  _mode: ChatMode,
): ModelName | null {
  if (tier === "auto") return null;
  switch (tier) {
    case "hackerai-standard":
      return "model-deepseek-v4-flash-0731";
    case "hackerai-pro":
      return "model-deepseek-v4-pro-0813";
    case "hackerai-max":
      return "model-grok-4.6";
  }
}

export const myProvider = customProvider({
  languageModels: baseProviders,
});

export const createTrackedProvider = () => myProvider;
