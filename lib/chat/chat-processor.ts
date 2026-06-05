import { getModerationResult } from "@/lib/moderation";
import type { ChatMode, SubscriptionTier, SelectedModel } from "@/types";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { UIMessage } from "ai";
import { processMessageFiles } from "@/lib/utils/file-transform-utils";
import {
  getMaxFilesLimitForMode,
  isSupportedImageMediaType,
} from "@/lib/utils/file-utils";
import {
  isAnthropicModel,
  resolveTierToProviderKey,
  type ModelName,
} from "@/lib/ai/providers";
import {
  AUTH_DISCLAIMER,
  type SupportedLang,
} from "@/lib/chat/auth-disclaimer";
import {
  ABORTED_TOOL_ERROR_TEXT,
  hasMeaningfulToolInput,
} from "@/lib/chat/tool-abort-utils";
/**
 * Get maximum steps allowed for a user based on mode and subscription.
 * Agent mode: 100 steps (all tiers).
 * Ask mode: Free 15, Paid 100.
 */
export const getMaxStepsForUser = (
  mode: ChatMode,
  subscription: SubscriptionTier,
): number => {
  if (isAgentMode(mode)) return 100;
  return subscription === "free" ? 15 : 100;
};

/**
 * Selects the appropriate model based on mode and subscription
 * @param mode - Chat mode (ask or agent)
 * @param hasImageOrPdf - Whether any message has an image or PDF attachment.
 *   Paid ASK on the Standard/auto route normally uses DeepSeek V4 Flash
 *   (text-only, much cheaper); when an image or PDF is present we promote to
 *   Gemini 3 Flash so vision/document parts are actually understood.
 * @returns Model name to use
 */
export function selectModel(
  mode: ChatMode,
  subscription: SubscriptionTier,
  selectedModel?: SelectedModel,
  hasImageOrPdf?: boolean,
): ModelName {
  const isAgent = isAgentMode(mode);
  // ASK takes the cheap DeepSeek text path for free users (always) and for
  // paid users only when no image/PDF is attached — DeepSeek is text-only,
  // so we promote to Gemini 3 Flash when vision/document parts are present.
  const askUsesDeepSeek =
    !isAgent && (subscription === "free" || !hasImageOrPdf);

  const autoModel: ModelName = isAgent
    ? subscription === "free"
      ? "agent-model-free"
      : "agent-model"
    : askUsesDeepSeek
      ? "ask-model-free"
      : "ask-model";

  // Free users always route through the auto router; paid users may pick a
  // tier explicitly. The tier id is mode-aware via resolveTierToProviderKey.
  if (!selectedModel || selectedModel === "auto" || subscription === "free") {
    return autoModel;
  }

  // Paid ASK Standard mirrors the auto-route split, but uses the explicit
  // `model-deepseek-v4-flash` / `model-gemini-3-flash` keys so any UI that
  // reads `getModelDisplayName` shows the picked model rather than the
  // auto-router label.
  if (selectedModel === "hackerai-standard" && !isAgent) {
    return askUsesDeepSeek ? "model-deepseek-v4-flash" : "model-gemini-3-flash";
  }

  const providerKey = resolveTierToProviderKey(selectedModel, mode);
  return providerKey ?? autoModel;
}

/**
 * True if any message has an image or PDF file part. Used by selectModel
 * to decide whether the cheaper DeepSeek V4 Flash text route is viable.
 */
function hasImageOrPdfAttachment(messages: UIMessage[]): boolean {
  return messages.some((msg) =>
    msg.parts?.some((part: any) => {
      if (part.type !== "file") return false;
      const mediaType: string = part.mediaType ?? "";
      return mediaType.startsWith("image/") || mediaType === "application/pdf";
    }),
  );
}

/**
 * Adds authorization message to the last user message.
 * Language is detected by moderation from the same combined text it scored,
 * since a short reply like "yes its mine" doesn't carry enough signal.
 */
export function addAuthMessage(
  messages: UIMessage[],
  moderationLanguage: SupportedLang,
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const message = messages[i];

      if (!message.parts) {
        message.parts = [];
      }

      const textParts = message.parts.filter(
        (part: any) => part.type === "text",
      ) as Array<{ type: "text"; text: string }>;

      const disclaimer = AUTH_DISCLAIMER[moderationLanguage];

      const firstTextPart = textParts[0];
      if (firstTextPart) {
        firstTextPart.text = `${firstTextPart.text} ${disclaimer}`;
      } else {
        message.parts.push({ type: "text", text: disclaimer });
      }
      break;
    }
  }
}

const ABORT_RENDERABLE_TOOL_TYPES = new Set([
  "tool-file",
  "tool-read_file",
  "tool-write_file",
  "tool-delete_file",
  "tool-search_replace",
  "tool-multi_edit",
  "tool-web_search",
  "tool-open_url",
  "tool-web",
  "tool-shell",
  "tool-run_terminal_cmd",
  "tool-interact_terminal_session",
  "tool-http_request",
  "tool-get_terminal_files",
  "tool-todo_write",
  "tool-create_note",
  "tool-list_notes",
  "tool-update_note",
  "tool-delete_note",
  "tool-list_requests",
  "tool-view_request",
  "tool-send_request",
  "tool-scope_rules",
  "tool-list_sitemap",
  "tool-view_sitemap_entry",
]);

type IncompleteMessagePartsLogContext = {
  service?: string;
  source?: string;
  chatId?: string;
  userId?: string;
  messageId?: string;
  mode?: string;
  finishReason?: string;
  updateOnly?: boolean;
};

function logIncompleteToolPartHandled({
  action,
  part,
  context,
}: {
  action: "converted_to_output_error" | "dropped";
  part: any;
  context?: IncompleteMessagePartsLogContext;
}) {
  if (!context) return;

  console.info(
    JSON.stringify({
      level: "info",
      event: "incomplete_tool_part_handled",
      service: context.service ?? "chat-processor",
      timestamp: new Date().toISOString(),
      source: context.source,
      chat_id: context.chatId,
      user_id: context.userId,
      message_id: context.messageId,
      mode: context.mode,
      finish_reason: context.finishReason,
      update_only: context.updateOnly,
      action,
      tool_type: part.type,
      tool_call_id: part.toolCallId,
      original_state: part.state,
      has_input: part.input != null,
      has_meaningful_input: hasMeaningfulToolInput(part.input),
      input_keys:
        part.input &&
        typeof part.input === "object" &&
        !Array.isArray(part.input)
          ? Object.keys(part.input as Record<string, unknown>).sort()
          : [],
    }),
  );
}

function createAbortedToolPart(part: any): any | null {
  if (
    !ABORT_RENDERABLE_TOOL_TYPES.has(part.type) ||
    !part.toolCallId ||
    !hasMeaningfulToolInput(part.input)
  ) {
    return null;
  }

  const { output: _output, result: _result, ...restPart } = part;
  return {
    ...restPart,
    state: "output-error",
    errorText: ABORTED_TOOL_ERROR_TEXT,
  };
}

/**
 * Fixes incomplete tool invocations and removes incomplete reasoning from message parts.
 * This can happen when a stream is interrupted. Without proper handling:
 * - Tool invocations without results cause AI_MissingToolResultsError
 * - Incomplete reasoning parts may cause "must include at least one parts field" errors
 *
 * We mark renderable aborted tools as output-error when they have enough input
 * to show what was stopped, and remove empty incomplete tools/reasoning (along
 * with any step-start that immediately precedes them).
 *
 * This function is exported for use in db/actions.ts as well.
 */
export function fixIncompleteMessageParts(
  parts: any[],
  options?: { logContext?: IncompleteMessagePartsLogContext },
): any[] {
  // First pass: fix incomplete tool invocations
  const partsWithFixedTools = parts.map((part: any) => {
    // Check for custom tool-xxx parts that aren't in a completed state
    const isToolPart = part.type && part.type.startsWith("tool-");

    // Skip parts that already have errorText - they're error states, not incomplete
    if (isToolPart && part.errorText) {
      return part;
    }

    const isIncomplete = isToolPart && part.state !== "output-available";

    // Also fix tool parts that incorrectly have state: "result" (legacy format)
    // Custom tool-xxx types need state: "output-available" with output, not state: "result" with result
    const hasWrongFormat =
      isToolPart && part.state === "result" && part.result !== undefined;

    if (isIncomplete || hasWrongFormat) {
      if (isIncomplete && part.output == null && part.result == null) {
        const abortedPart = createAbortedToolPart(part);
        if (abortedPart) {
          logIncompleteToolPartHandled({
            action: "converted_to_output_error",
            part,
            context: options?.logContext,
          });
          return abortedPart;
        }

        // Empty or unknown tools were interrupted before producing any useful
        // display state. Removing them avoids polluting model history with
        // fabricated tool calls and prevents provider errors on resume.
        logIncompleteToolPartHandled({
          action: "dropped",
          part,
          context: options?.logContext,
        });
        return null; // Mark for removal in second pass
      }

      // Custom tool-xxx format uses state: "output-available" with output property
      // Convert result to output if it exists (legacy data migration)
      const output = part.output ?? part.result;
      const { result: _result, ...restPart } = part;
      return {
        ...restPart,
        state: "output-available",
        output,
      };
    }
    return part;
  });

  // Second pass: remove incomplete reasoning, removed tool parts, and their preceding step-starts
  const filteredParts: any[] = [];
  for (let i = 0; i < partsWithFixedTools.length; i++) {
    const part = partsWithFixedTools[i];

    // Skip tool parts marked for removal (interrupted before receiving input)
    if (part === null) {
      // Remove the step-start that immediately precedes this tool (if any)
      if (
        filteredParts.length > 0 &&
        filteredParts[filteredParts.length - 1].type === "step-start"
      ) {
        filteredParts.pop();
      }
      continue;
    }

    // Check if this is an incomplete reasoning part
    const isIncompleteReasoning =
      part.type === "reasoning" &&
      part.state !== "done" &&
      part.state !== undefined;

    if (isIncompleteReasoning) {
      // Remove the step-start that immediately precedes this reasoning (if any)
      if (
        filteredParts.length > 0 &&
        filteredParts[filteredParts.length - 1].type === "step-start"
      ) {
        filteredParts.pop();
      }
      // Skip adding this incomplete reasoning part
      continue;
    }

    filteredParts.push(part);
  }

  // Third pass: trim trailing incomplete steps that would become empty model messages.
  // When a stream is interrupted mid-reasoning (before producing text or tool calls),
  // the message ends with [step-start, reasoning, ...] but no text/tool content for that step.
  // convertToModelMessages() splits by step boundaries, creating an assistant model message
  // with only reasoning content — which Gemini rejects with
  // "must include at least one parts field" error.
  let lastStepStartIdx = -1;
  for (let i = filteredParts.length - 1; i >= 0; i--) {
    if (filteredParts[i].type === "step-start") {
      lastStepStartIdx = i;
      break;
    }
  }

  if (lastStepStartIdx >= 0) {
    const lastStepHasContent = filteredParts
      .slice(lastStepStartIdx + 1)
      .some((part: any) => {
        if (part.type === "text") return !!part.text?.trim();
        if (part.type?.startsWith("tool-") || part.type === "dynamic-tool")
          return true;
        if (part.type === "file") return true;
        // reasoning and step-start alone are not content for Gemini
        return false;
      });

    if (!lastStepHasContent) {
      return filteredParts.slice(0, lastStepStartIdx);
    }
  }

  return filteredParts;
}

/**
 * Applies fixIncompleteMessageParts to all assistant messages in a conversation.
 */
function fixIncompleteToolInvocations(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.parts) {
      return message;
    }

    const fixedParts = fixIncompleteMessageParts(message.parts);
    const hasChanges =
      fixedParts.length !== message.parts.length ||
      fixedParts.some((part, i) => part !== message.parts[i]);

    return hasChanges ? { ...message, parts: fixedParts } : message;
  });
}

/**
 * Removes duplicate tool parts from messages.
 *
 * When a model calls an unavailable tool, both a custom `tool-{toolName}` part
 * AND a `dynamic-tool` part may be created with the same `toolCallId`.
 * This causes "tool call id is duplicated" errors from providers like Moonshot AI.
 *
 * This function removes `dynamic-tool` parts when there's already a matching
 * custom `tool-xxx` part with the same toolCallId.
 */
function removeDuplicateToolParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.parts) {
      return message;
    }

    // Collect toolCallIds from custom tool-xxx parts (excluding dynamic-tool)
    const customToolIds = new Set(
      message.parts
        .filter(
          (p: any) =>
            p.type?.startsWith("tool-") &&
            p.type !== "dynamic-tool" &&
            p.toolCallId,
        )
        .map((p: any) => p.toolCallId),
    );

    // Filter out dynamic-tool parts that duplicate custom tool-xxx parts
    const filteredParts = message.parts.filter((p: any) => {
      if (p.type === "dynamic-tool" && customToolIds.has(p.toolCallId)) {
        return false; // Skip this duplicate
      }
      return true;
    });

    return filteredParts.length !== message.parts.length
      ? { ...message, parts: filteredParts }
      : message;
  });
}

/**
 * Strips bulky UI-only fields from historical tool outputs before they're
 * fed back into the model context.
 *
 * Tools' own `toModelOutput` handles the current step's result, but
 * `convertToModelMessages` is called here without the tools registry, so
 * `toModelOutput` is bypassed for past results — we strip explicitly.
 *
 * - `tool-file` (read/edit/append): drops originalContent / modifiedContent
 * - `tool-update_note`: drops original / modified diff data
 * - `tool-run_terminal_cmd` / `tool-interact_terminal_session`: drops
 *   rawSnapshot (raw ANSI byte buffer used only by the sidebar's xterm
 *   renderer; the model already has `output` and `sessionSnapshot`).
 */
function stripOriginalContentFromMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.parts) {
      return message;
    }

    let hasChanges = false;
    const cleanedParts = message.parts.map((part: any) => {
      // Process tool-file parts with read, edit, or append action and object output
      if (
        part.type === "tool-file" &&
        (part.input?.action === "read" ||
          part.input?.action === "edit" ||
          part.input?.action === "append") &&
        typeof part.output === "object" &&
        part.output !== null &&
        ("originalContent" in part.output || "modifiedContent" in part.output)
      ) {
        hasChanges = true;
        const { originalContent, modifiedContent, ...restOutput } = part.output;
        return {
          ...part,
          output: restOutput,
        };
      }

      // Process tool-update_note parts to strip original/modified diff data
      if (
        part.type === "tool-update_note" &&
        typeof part.output === "object" &&
        part.output !== null &&
        ("original" in part.output || "modified" in part.output)
      ) {
        hasChanges = true;
        const { original, modified, ...restOutput } = part.output;
        return {
          ...part,
          output: restOutput,
        };
      }

      // Process PTY tool parts to strip rawSnapshot. Output shape is
      // `{ result: { output, sessionSnapshot, rawSnapshot, ... } }`.
      if (
        (part.type === "tool-run_terminal_cmd" ||
          part.type === "tool-interact_terminal_session") &&
        typeof part.output === "object" &&
        part.output !== null &&
        typeof (part.output as any).result === "object" &&
        (part.output as any).result !== null &&
        "rawSnapshot" in (part.output as any).result
      ) {
        hasChanges = true;
        const { rawSnapshot, ...restResult } = (part.output as any).result;
        return {
          ...part,
          output: { ...part.output, result: restResult },
        };
      }

      return part;
    });

    return hasChanges ? { ...message, parts: cleanedParts } : message;
  });
}

/**
 * Limits the number of image file parts across all messages to stay within provider limits.
 * Only counts image files — PDFs and other file types
 * are left untouched. Keeps the most recent images by removing the oldest ones first.
 */
export function limitImageParts(
  messages: UIMessage[],
  mode: ChatMode = "ask",
): UIMessage[] {
  const maxImagesPerConversation = getMaxFilesLimitForMode(mode);
  const imagePositions: Array<{ messageIndex: number; partIndex: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.parts) continue;
    (msg.parts as any[]).forEach((part: any, j) => {
      if (
        part.type === "file" &&
        part.mediaType &&
        isSupportedImageMediaType(part.mediaType)
      ) {
        imagePositions.push({ messageIndex: i, partIndex: j });
      }
    });
  }

  if (imagePositions.length <= maxImagesPerConversation) {
    return messages;
  }

  const removedCount = imagePositions.length - maxImagesPerConversation;
  console.log(
    `[limitImageParts] Removing ${removedCount} oldest image parts (${imagePositions.length} total, limit ${maxImagesPerConversation})`,
  );

  // Remove the oldest images, keep the last maxImagesPerConversation.
  const toRemove = new Set(
    imagePositions
      .slice(0, imagePositions.length - maxImagesPerConversation)
      .map(({ messageIndex, partIndex }) => `${messageIndex}:${partIndex}`),
  );

  return messages.map((msg, msgIdx) => {
    if (!msg.parts) return msg;

    const filteredParts = msg.parts.filter(
      (_, partIdx) => !toRemove.has(`${msgIdx}:${partIdx}`),
    );

    return filteredParts.length !== msg.parts.length
      ? { ...msg, parts: filteredParts }
      : msg;
  });
}

// isAnthropicModel is imported from @/lib/ai/providers
// (covers both Sonnet and Opus)

/**
 * Strips providerMetadata from all parts in all messages.
 * Anthropic models require valid signatures on thinking blocks, and signatures
 * from other models (or different Anthropic models) cause "Invalid signature in
 * thinking block" 400 errors. Stripping providerMetadata removes these signatures.
 * Only applied for Anthropic models — other providers (e.g., Gemini) need
 * providerMetadata/thought_signature for tool calling to work.
 */
function stripProviderMetadata(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (!message.parts) return message;

    let hasChanges = false;
    const cleanedParts = message.parts.map((part: any) => {
      if (
        part.providerMetadata ||
        part.callProviderMetadata ||
        part.providerExecuted ||
        part.providerOptions
      ) {
        hasChanges = true;
        const {
          providerMetadata,
          callProviderMetadata,
          providerExecuted,
          providerOptions,
          ...rest
        } = part;
        return rest;
      }
      return part;
    });

    return hasChanges ? { ...message, parts: cleanedParts } : message;
  });
}

// UI-only part types that should not be sent to AI providers
const UI_ONLY_PART_TYPES = new Set(["data-summarization"]);

/**
 * Filters out UI-only parts from a message that AI providers don't understand.
 */
const filterUIOnlyParts = <T extends { parts?: any[] }>(message: T): T => {
  if (!message.parts) return message;

  const filteredParts = message.parts.filter(
    (part: any) => !UI_ONLY_PART_TYPES.has(part.type),
  );

  // Only create new object if parts were actually filtered
  if (filteredParts.length === message.parts.length) return message;

  return { ...message, parts: filteredParts };
};

/**
 * Processes chat messages with moderation, truncation, and analytics
 */
export async function processChatMessages({
  messages,
  mode,
  userId,
  subscription,
  uploadBasePath,
  modelOverride,
  allowLocalDesktopFiles = false,
}: {
  messages: UIMessage[];
  mode: ChatMode;
  userId: string;
  subscription: SubscriptionTier;
  uploadBasePath?: string;
  modelOverride?: SelectedModel;
  allowLocalDesktopFiles?: boolean;
}) {
  // Filter out UI-only parts (data-summarization) that AI providers don't understand
  const messagesWithoutUIOnlyParts = messages.map(filterUIOnlyParts);

  // Limit image parts before fetching URLs to avoid unnecessary S3 requests
  // Keep image attachment pruning aligned with the per-message upload cap.
  const messagesWithLimitedFiles = limitImageParts(
    messagesWithoutUIOnlyParts,
    mode,
  );

  // Process all file attachments: transform URLs, detect media/PDFs, and add document content
  const { messages: messagesWithUrls, sandboxFiles } =
    await processMessageFiles(
      messagesWithLimitedFiles,
      mode,
      userId,
      uploadBasePath,
      subscription,
      allowLocalDesktopFiles,
    );

  // Fix incomplete tool invocations and reasoning (from interrupted streams) before filtering.
  // This must happen BEFORE the empty-content filter because fixing incomplete parts can
  // remove tool invocations and step-starts, potentially leaving messages with no content.
  const messagesWithFixedTools = fixIncompleteToolInvocations(messagesWithUrls);

  // Filter out messages with empty parts or parts without meaningful content
  // This prevents "must include at least one parts field" errors from providers like Gemini
  const messagesWithContent = messagesWithFixedTools.filter((msg) => {
    if (!msg.parts || msg.parts.length === 0) return false;

    // For assistant messages, we need actual content (text or tool parts), not just reasoning/step-start
    // Gemini specifically requires text or tool content, reasoning alone causes errors
    if (msg.role === "assistant") {
      return msg.parts.some((part: any) => {
        // Text parts need actual text content
        if (part.type === "text") return part.text?.trim().length > 0;
        // Tool parts are valid content
        if (part.type?.startsWith("tool-")) return true;
        // File parts are valid content
        if (part.type === "file") return !!part.url || !!part.fileId;
        // reasoning and step-start alone are NOT sufficient for assistant messages
        return false;
      });
    }

    // For user messages, check that at least one part has meaningful content
    return msg.parts.some((part: any) => {
      if (part.type === "text") return part.text?.trim().length > 0;
      if (part.type === "file") return !!part.url || !!part.fileId;
      // reasoning must have text content
      if (part.type === "reasoning") return !!part.text?.trim();
      // Keep other part types as they have implicit content
      return true;
    });
  });

  // Remove duplicate tool parts (dynamic-tool duplicates of tool-xxx parts)
  // This prevents "tool call id is duplicated" errors from providers
  const messagesWithoutDuplicates =
    removeDuplicateToolParts(messagesWithContent);

  // Select the appropriate model early so we can make model-aware decisions below
  const selectedModel = selectModel(
    mode,
    subscription,
    modelOverride,
    hasImageOrPdfAttachment(messagesWithoutDuplicates),
  );

  // Strip providerMetadata for Anthropic models to prevent cross-model signature errors.
  // Anthropic requires valid signatures on thinking blocks, and signatures from other
  // models (or different Anthropic models) cause "Invalid signature in thinking block"
  // 400 errors. Other providers (e.g., Gemini) need providerMetadata for tool calling,
  // so we only strip it when targeting Anthropic.
  const sanitizedMessages = isAnthropicModel(selectedModel)
    ? stripProviderMetadata(messagesWithoutDuplicates)
    : messagesWithoutDuplicates;

  // Strip originalContent from file edit outputs (large data not needed by model)
  const cleanedMessages = stripOriginalContentFromMessages(sanitizedMessages);

  // Check moderation for the last user message
  const moderationResult = await getModerationResult(
    cleanedMessages,
    subscription !== "free",
  );

  // If moderation allows, add authorization message
  if (moderationResult.shouldUncensorResponse) {
    addAuthMessage(cleanedMessages, moderationResult.language);
  }

  return {
    processedMessages: cleanedMessages,
    selectedModel,
    sandboxFiles,
  };
}
