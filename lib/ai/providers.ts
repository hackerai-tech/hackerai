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
  "The provider could not parse one or more attached files. Use the corresponding local_path values and inspect the files with sandbox tools instead of asking the provider to parse them again.";

const createSandboxPdfRecoveryBody = (
  body: unknown,
  removeAllFileParts = false,
): { body: unknown; changed: boolean } => {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { body, changed: false };
  }
  const sandboxAttachmentFilenames = collectSandboxAttachmentFilenames(
    body.messages,
  );
  if (sandboxAttachmentFilenames.size === 0) {
    return { body, changed: false };
  }

  let removedFilePart = false;
  let lastUserMessageIndex = -1;
  const messages = body.messages.map((message, index) => {
    if (!isRecord(message)) return message;
    if (message.role === "user") lastUserMessageIndex = index;
    if (!Array.isArray(message.content)) return message;

    const content = message.content.filter((part) => {
      const filename = getFileRequestFilename(part);
      const shouldRemove =
        Boolean(filename && sandboxAttachmentFilenames.has(filename)) &&
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

    const initialResponse = await fetchImplementation(url, nextInit);
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
      const sandboxResponse = await fetchImplementation(url, {
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
      const sandboxResponse = await fetchImplementation(url, {
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
    const cloudflareResponse = await fetchImplementation(url, {
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
    const sandboxResponse = await fetchImplementation(url, {
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
export const GROK_4_5_SLUG = "x-ai/grok-4.5";
export const GROK_4_6_SLUG = "x-ai/grok-4.6";
// Prefer DeepSeek's purpose-built vision model for auxiliary image analysis,
// with MiMo-V2.5 retained as the cyber-friendly provider fallback.
export const AUXILIARY_VISION_SLUG = "deepseek/deepseek-v4-flash-vision-exp";
export const AUXILIARY_VISION_FALLBACK_SLUG = "xiaomi/mimo-v2.5";
export const DEEPSEEK_V4_PRO_SLUG = "deepseek/deepseek-v4-pro";
export const DEEPSEEK_V4_PRO_0813_SLUG = "deepseek/deepseek-v4-pro-0813";
export const DEEPSEEK_V4_FLASH_SLUG = "deepseek/deepseek-v4-flash-0731";
export const DEEPSEEK_V4_FLASH_PREVIOUS_SLUG = "deepseek/deepseek-v4-flash";
const TITLE_GENERATOR_DEEPSEEK_SLUG = "deepseek/deepseek-v4-flash";

export const getOpenRouterProviderRoutingForModel = (
  modelSlug: string,
): { ignore: string[] } | undefined =>
  modelSlug === DEEPSEEK_V4_FLASH_PREVIOUS_SLUG
    ? { ignore: ["novita"] }
    : undefined;

const buildProviderMap = (
  or: OpenRouterInstance,
  freeAskDeepSeekSlug = DEEPSEEK_V4_FLASH_PREVIOUS_SLUG,
  freeAgentDeepSeekSlug = DEEPSEEK_V4_FLASH_SLUG,
) =>
  ({
    "ask-model": or(GROK_4_6_SLUG),
    "ask-model-free": or(freeAskDeepSeekSlug),
    "agent-model": or(GROK_4_6_SLUG),
    "agent-model-free": or(freeAgentDeepSeekSlug),
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
    modelName === "ask-model-free" ||
    modelName === "agent-model-free" ||
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
