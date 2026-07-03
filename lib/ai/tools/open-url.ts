import { tool } from "ai";
import { z } from "zod";
import { phLogger } from "@/lib/posthog/server";
import { truncateContent } from "@/lib/token-utils";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import type { ToolContext } from "@/types";
import { toolBriefSchema } from "./tool-brief";
import { reportToolFailure } from "./tool-failure";

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
  Pick<ToolContext, "chatId" | "onToolFailure" | "userID">
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

/**
 * Open URL tool using Jina AI for content retrieval
 * Retrieves and returns the full contents of a webpage
 */
export const createOpenUrlTool = (context?: OpenUrlLogContext) => {
  return tool({
    description: `Retrieve the full contents of a specific webpage by URL.

<instructions>
- Use to fetch and read a specific webpage, usually obtained from a prior search
- URLs must be valid and publicly accessible
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
</instructions>`,
    inputSchema: z.object({
      url: z.string().describe("The URL to open and retrieve content from"),
      brief: toolBriefSchema,
    }),
    execute: async ({ url }: { url: string }, { abortSignal }) => {
      const startedAt = Date.now();

      try {
        // Construct the Jina AI reader URL with proper encoding
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;

        // Make the request to Jina AI reader
        const response = await fetch(jinaUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.JINA_API_KEY}`,
            "X-Timeout": "30",
            "X-Base": "final",
            "X-Token-Budget": "200000",
          },
          signal: abortSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
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
          return `Error: HTTP ${response.status} - ${errorBody}`;
        }

        const content = await response.text();
        const truncated = truncateContent(content, undefined, 2048);

        return truncated;
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (error instanceof Error && error.name === "AbortError") {
          return "Error: Operation aborted";
        }

        const isNetworkFailure = isOpenUrlNetworkError(error);
        const errorCode = getNestedErrorCode(error);
        const errorMessage = stringifyRedactedError(error);
        const logFields = {
          event: isNetworkFailure
            ? "open_url_fetch_failed"
            : "open_url_tool_failed",
          provider: "jina",
          url_hostname: getUrlHostname(url),
          duration_ms: Date.now() - startedAt,
          ...(context?.chatId && { chat_id: context.chatId }),
          ...(context?.userID && { userId: context.userID }),
          ...(errorCode && { error_code: errorCode }),
          error_name: getErrorName(error),
          error_message: errorMessage,
        };
        reportToolFailure(context?.onToolFailure, {
          event: logFields.event,
          tool_name: "open_url",
          provider: "jina",
          duration_ms: logFields.duration_ms,
          url_hostname: logFields.url_hostname,
          ...(errorCode && { error_code: errorCode }),
          error_name: logFields.error_name,
          error_message: errorMessage,
        });

        if (isNetworkFailure) {
          phLogger.warn("Open URL provider fetch failed", logFields);
          return "Error opening URL: The URL reader timed out or could not reach the page. Do not retry the same URL unless the user asks.";
        }

        phLogger.error("Open URL tool error", logFields);
        return `Error opening URL: ${errorMessage}`;
      }
    },
  });
};
