import { tool } from "ai";
import { ToolContext } from "@/types";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import {
  PerplexityApiError,
  PerplexitySearchResult,
  PerplexitySearchResponse,
  RECENCY_MAP,
  buildPerplexitySearchBody,
  formatSearchResults,
  isRetryablePerplexityStatus,
  summarizePerplexityErrorBody,
} from "./utils/perplexity";
import { PERPLEXITY_QUERY_MAX_LENGTH, webSearchTool } from "./schemas";

/**
 * Web search tool using Perplexity Search API
 * Provides ranked web search results with content extraction
 */
/** Perplexity Search API cost: $5 per 1K requests */
const WEB_SEARCH_COST_PER_REQUEST = 0.005;
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const WEB_SEARCH_MAX_ATTEMPTS = 3;
const WEB_SEARCH_RETRY_BASE_DELAY_MS = 300;
const WEB_SEARCH_RETRY_JITTER_MS = 75;
const EMPTY_QUERY_TOOL_ERROR =
  "Error performing web search: Provide at least one non-empty query.";
const QUERY_TOO_LONG_TOOL_ERROR = `Error performing web search: Each query must be ${PERPLEXITY_QUERY_MAX_LENGTH} characters or fewer.`;

const sleep = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const getRetryDelayMs = (attemptIndex: number): number => {
  const exponentialDelay =
    WEB_SEARCH_RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
  const jitter = Math.random() * WEB_SEARCH_RETRY_JITTER_MS;
  return Math.round(exponentialDelay + jitter);
};

const createPerplexityApiError = async (
  response: Response,
): Promise<PerplexityApiError> => {
  const errorText = await response.text();
  const bodySummary = summarizePerplexityErrorBody(
    errorText,
    response.headers.get("content-type") || "",
  );

  return new PerplexityApiError({
    status: response.status,
    statusText: response.statusText,
    bodySummary,
    retryable: isRetryablePerplexityStatus(response.status),
  });
};

const formatPerplexityFailureForTool = (
  error: PerplexityApiError,
  attempts: number,
): string => {
  const statusText = error.statusText ? ` ${error.statusText}` : "";

  if (error.retryable) {
    return `Error performing web search: Perplexity search is temporarily unavailable (HTTP ${error.status}${statusText} after ${attempts} attempts). Please retry shortly or continue without live web results if the task can proceed.`;
  }

  if (error.status === 401 || error.status === 403) {
    return `Error performing web search: Perplexity search is not authorized (HTTP ${error.status}${statusText}). Check the Perplexity API key or account access.`;
  }

  return `Error performing web search: Perplexity search failed (HTTP ${error.status}${statusText}).`;
};

const fetchPerplexitySearch = async (
  searchBody: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<Response> => {
  for (
    let attemptIndex = 0;
    attemptIndex < WEB_SEARCH_MAX_ATTEMPTS;
    attemptIndex++
  ) {
    const attempt = attemptIndex + 1;
    const isFinalAttempt = attempt === WEB_SEARCH_MAX_ATTEMPTS;

    try {
      const response = await fetch(PERPLEXITY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY || ""}`,
        },
        body: JSON.stringify(searchBody),
        signal: abortSignal,
      });

      if (response.ok) {
        return response;
      }

      const error = await createPerplexityApiError(response);

      if (!error.retryable || isFinalAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attemptIndex);
      console.warn("Web search provider error; retrying", {
        attempt,
        maxAttempts: WEB_SEARCH_MAX_ATTEMPTS,
        status: error.status,
        statusText: error.statusText,
        bodySummary: error.bodySummary,
        delayMs,
      });
      await sleep(delayMs, abortSignal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      if (error instanceof PerplexityApiError) {
        throw error;
      }

      if (isFinalAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attemptIndex);
      console.warn("Web search network error; retrying", {
        attempt,
        maxAttempts: WEB_SEARCH_MAX_ATTEMPTS,
        error: stringifyRedactedError(error),
        delayMs,
      });
      await sleep(delayMs, abortSignal);
    }
  }

  throw new Error("Web search failed before any Perplexity response was read");
};

const normalizeSearchQueries = (
  rawQueries: string[],
): { queries: string[]; error?: string } => {
  const queries = rawQueries.map((query) => query.trim()).filter(Boolean);

  if (queries.length === 0) {
    return { queries, error: EMPTY_QUERY_TOOL_ERROR };
  }

  if (queries.some((query) => query.length > PERPLEXITY_QUERY_MAX_LENGTH)) {
    return { queries, error: QUERY_TOO_LONG_TOOL_ERROR };
  }

  return { queries: queries.slice(0, 3) };
};

export const createWebSearch = (context: ToolContext) => {
  const { userLocation, onToolCost } = context;

  return tool({
    ...webSearchTool,
    execute: async (
      {
        queries: rawQueries,
        time,
      }: {
        brief?: string;
        queries: string[];
        time?: "all" | "past_day" | "past_week" | "past_month" | "past_year";
      },
      { abortSignal },
    ) => {
      try {
        const { queries, error } = normalizeSearchQueries(rawQueries);
        if (error) {
          return error;
        }

        const searchBody = buildPerplexitySearchBody(
          queries.length === 1 ? queries[0] : queries,
          {
            country: userLocation?.country,
            recency: time && time !== "all" ? RECENCY_MAP[time] : undefined,
          },
        );

        const response = await fetchPerplexitySearch(searchBody, abortSignal);

        // Report web search cost ($5 per 1K requests)
        onToolCost?.(WEB_SEARCH_COST_PER_REQUEST);

        const searchResponse: PerplexitySearchResponse = await response.json();

        // Handle both single query (flat array) and multi-query (nested arrays) responses
        const isMultiQuery = queries.length > 1;
        let allResults: PerplexitySearchResult[];

        if (isMultiQuery && Array.isArray(searchResponse.results[0])) {
          // Multi-query response: flatten results from all queries
          allResults = (
            searchResponse.results as PerplexitySearchResult[][]
          ).flat();
        } else {
          // Single query response: results is already a flat array
          allResults = searchResponse.results as PerplexitySearchResult[];
        }

        return formatSearchResults(allResults);
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (error instanceof Error && error.name === "AbortError") {
          return "Error: Operation aborted";
        }

        if (error instanceof PerplexityApiError) {
          console.error("Web search tool error:", {
            name: error.name,
            status: error.status,
            statusText: error.statusText,
            retryable: error.retryable,
            bodySummary: error.bodySummary,
          });
          return formatPerplexityFailureForTool(
            error,
            error.retryable ? WEB_SEARCH_MAX_ATTEMPTS : 1,
          );
        }

        const errorMessage = stringifyRedactedError(error);
        console.error("Web search tool error:", errorMessage);
        return `Error performing web search: ${errorMessage}`;
      }
    },
  });
};
