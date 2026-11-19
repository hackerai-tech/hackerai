import { tool } from "ai";
import { phLogger } from "@/lib/posthog/server";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import type { ToolContext } from "@/types";
import { reportToolFailure } from "./tool-failure";
import {
  JINA_CONTENT_HEADERS,
  formatUrlContentPage,
  getUrlContentFailure,
} from "./utils/url-content";
import {
  createOpenUrlToolSchema,
  openUrlTool,
  type OpenUrlToolInput,
} from "./schemas";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NETWORK_ERROR_MESSAGE_PATTERN =
  /fetch failed|failed to fetch|network|timed?\s*out|timeout|connection (?:closed|reset|refused)|socket|getaddrinfo/i;

type OpenUrlLogContext = Partial<
  Pick<
    ToolContext,
    "chatId" | "getCurrentModelName" | "modelName" | "onToolFailure" | "userID"
  >
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getNestedErrorCode = (
  error: unknown,
  seen = new Set<unknown>(),
): string | undefined => {
  if (!isRecord(error) || seen.has(error)) return undefined;
  seen.add(error);

  if (typeof error.code === "string") return error.code;

  const causeCode = getNestedErrorCode(error.cause, seen);
  if (causeCode) return causeCode;

  if (Array.isArray(error.errors)) {
    for (const nestedError of error.errors) {
      const nestedCode = getNestedErrorCode(nestedError, seen);
      if (nestedCode) return nestedCode;
    }
  }

  return undefined;
};

const getErrorName = (error: unknown): string =>
  error instanceof Error ? error.name : "UnknownError";

const getUrlHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid_url";
  }
};

const isOpenUrlNetworkError = (error: unknown): boolean => {
  const errorCode = getNestedErrorCode(error);
  if (errorCode && NETWORK_ERROR_CODES.has(errorCode)) return true;

  return (
    error instanceof Error && NETWORK_ERROR_MESSAGE_PATTERN.test(error.message)
  );
};

const isOpenUrlCancellation = (
  error: unknown,
  abortSignal?: AbortSignal,
): boolean => {
  if (abortSignal?.aborted) return true;
  if (isRecord(error) && error.name === "AbortError") return true;

  const message = error instanceof Error ? error.message : error;
  return (
    typeof message === "string" &&
    [
      "run cancelled",
      "run canceled",
      "cancelled by user",
      "canceled by user",
    ].includes(message.toLowerCase())
  );
};

const toDiagnosticError = (error: unknown, message: string): Error => {
  if (error instanceof Error) return error;

  const diagnosticError = new Error(message);
  diagnosticError.name = getErrorName(error);
  return diagnosticError;
};

/**
 * Open URL tool using Jina AI for content retrieval
 * Retrieves and returns the full contents of a webpage
 */
export const createOpenUrlTool = (context?: OpenUrlLogContext) => {
  // Keep only the latest document, scoped to this tool instance (never global or
  // shared across chats). A rebuilt worker can refetch and verify the cursor.
  let snapshot: { url: string; content: string; expiresAt: number } | undefined;
  return tool({
    ...openUrlTool,
    inputSchema: createOpenUrlToolSchema({
      modelName: context?.getCurrentModelName?.() ?? context?.modelName,
    }).inputSchema,
    execute: async ({ url, cursor }: OpenUrlToolInput, { abortSignal }) => {
      const startedAt = Date.now();

      try {
        if (abortSignal?.aborted) return "Error: Operation aborted";
        if (snapshot && snapshot.expiresAt <= startedAt) snapshot = undefined;
        if (cursor && snapshot?.url === url) {
          return formatUrlContentPage(snapshot.content, url, cursor);
        }
        // Construct the Jina AI reader URL with proper encoding
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;

        // Make the request to Jina AI reader
        const response = await fetch(jinaUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.JINA_API_KEY}`,
            ...JINA_CONTENT_HEADERS,
          },
          signal: abortSignal,
        });

        if (!response.ok) {
          // Provider error pages can be arbitrarily large and may reflect request
          // details. Only the status belongs in the model's error result.
          await response.body?.cancel().catch(() => {});
          reportToolFailure(context?.onToolFailure, {
            event: "open_url_provider_failed",
            tool_name: "open_url",
            provider: "jina",
            status: response.status,
            status_text: response.statusText,
            duration_ms: Date.now() - startedAt,
            url_hostname: getUrlHostname(url),
            error_message: `HTTP ${response.status}`,
          });
          return `Error opening URL: The URL reader request failed (HTTP ${response.status}).`;
        }

        const content = await response.text();
        const failure = getUrlContentFailure(content);
        if (failure) {
          reportToolFailure(context?.onToolFailure, {
            event: "open_url_content_unavailable",
            tool_name: "open_url",
            provider: "jina",
            duration_ms: Date.now() - startedAt,
            url_hostname: getUrlHostname(url),
            // Static classification only; page text/URLs never enter analytics.
            error_message: failure,
          });
          return `Error opening URL: ${failure} Do not retry the same URL unless the user asks.`;
        }
        // Bound retained memory even when Reader returns an unusually large page.
        snapshot =
          Buffer.byteLength(content, "utf8") <= 2 * 1024 * 1024
            ? { url, content, expiresAt: Date.now() + 5 * 60_000 }
            : undefined;
        return formatUrlContentPage(content, url, cursor);
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (isOpenUrlCancellation(error, abortSignal)) {
          return "Error: Operation aborted";
        }

        const isNetworkFailure = isOpenUrlNetworkError(error);
        const errorCode = getNestedErrorCode(error);
        const errorMessage = stringifyRedactedError(error);
        const toolFailureFields = {
          event: isNetworkFailure
            ? "open_url_fetch_failed"
            : "open_url_tool_failed",
          provider: "jina",
          url_hostname: getUrlHostname(url),
          duration_ms: Date.now() - startedAt,
          ...(errorCode && { error_code: errorCode }),
          error_name: getErrorName(error),
          error_message: errorMessage,
        };
        const { error_name, error_message, ...failureContext } =
          toolFailureFields;
        const logFields = {
          ...failureContext,
          // phLogger reserves error_name/error_message for the captured summary.
          tool_error_name: stringifyRedactedError(error_name).slice(0, 128),
          tool_error_message: error_message.slice(0, 2_000),
          ...(context?.chatId && { chat_id: context.chatId }),
          ...(context?.userID && { userId: context.userID }),
        };
        reportToolFailure(context?.onToolFailure, {
          ...toolFailureFields,
          tool_name: "open_url",
        });

        if (isNetworkFailure) {
          phLogger.warn("Open URL provider fetch failed", logFields);
          return "Error opening URL: The URL reader timed out or could not reach the page. Do not retry the same URL unless the user asks.";
        }

        phLogger.error("Open URL tool error", {
          ...logFields,
          error: toDiagnosticError(error, errorMessage),
        });
        return `Error opening URL: ${errorMessage}`;
      }
    },
  });
};
