import { redactSensitiveErrorMessage } from "@/lib/utils/error-redaction";

// Max tokens per search result content field
export const SEARCH_RESULT_CONTENT_MAX_TOKENS = 250;

// Map user-facing recency values to Perplexity API format
export const RECENCY_MAP: Record<string, "day" | "week" | "month" | "year"> = {
  past_day: "day",
  past_week: "week",
  past_month: "month",
  past_year: "year",
};

export interface PerplexitySearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  last_updated?: string;
}

export interface PerplexitySearchResponse {
  results: PerplexitySearchResult[] | PerplexitySearchResult[][];
  id: string;
}

export class PerplexityApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly bodySummary: string;
  readonly retryable: boolean;

  constructor({
    status,
    statusText,
    bodySummary,
    retryable,
  }: {
    status: number;
    statusText: string;
    bodySummary: string;
    retryable: boolean;
  }) {
    const statusLabel = statusText ? `${status} ${statusText}` : `${status}`;
    const summary = bodySummary ? `: ${bodySummary}` : "";
    super(`Perplexity API error ${statusLabel}${summary}`);
    this.name = "PerplexityApiError";
    this.status = status;
    this.statusText = statusText;
    this.bodySummary = bodySummary;
    this.retryable = retryable;
  }
}

const ERROR_BODY_SUMMARY_MAX_LENGTH = 400;

const RETRYABLE_PERPLEXITY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  "#160": " ",
  "#39": "'",
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const decodeBasicHtmlEntities = (value: string): string =>
  value.replace(/&([a-zA-Z0-9#]+);/g, (match, entity) => {
    return HTML_ENTITY_MAP[entity] ?? match;
  });

const stripHtml = (value: string): string =>
  normalizeWhitespace(
    decodeBasicHtmlEntities(
      value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );

const extractHtmlTagText = (html: string, tagName: string): string[] => {
  const matches = html.matchAll(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"),
  );

  return Array.from(matches)
    .map((match) => stripHtml(match[1] ?? ""))
    .filter(Boolean);
};

const redactNetworkDetails = (value: string): string =>
  value
    .replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
      "[Redacted IP]",
    )
    .replace(/\bRay ID:\s*[a-f0-9]+\b/gi, "Ray ID: [Redacted]");

const truncateSummary = (value: string): string =>
  value.length > ERROR_BODY_SUMMARY_MAX_LENGTH
    ? `${value.slice(0, ERROR_BODY_SUMMARY_MAX_LENGTH - 1)}…`
    : value;

export const isRetryablePerplexityStatus = (status: number): boolean =>
  RETRYABLE_PERPLEXITY_STATUSES.has(status);

export const summarizePerplexityErrorBody = (
  body: string,
  contentType = "",
): string => {
  const trimmed = body.trim();
  if (!trimmed) return "";

  let summary = "";

  if (contentType.includes("json") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      const error =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error &&
              typeof parsed.error === "object" &&
              "message" in parsed.error &&
              typeof parsed.error.message === "string"
            ? parsed.error.message
            : undefined;
      const message =
        error ||
        (typeof parsed.message === "string" ? parsed.message : undefined) ||
        (typeof parsed.detail === "string" ? parsed.detail : undefined);
      summary = message || trimmed;
    } catch {
      summary = trimmed;
    }
  } else if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    const tagSummaries = [
      ...extractHtmlTagText(trimmed, "h1"),
      ...extractHtmlTagText(trimmed, "p"),
      ...extractHtmlTagText(trimmed, "h2"),
    ];
    summary =
      tagSummaries.length > 0 ? tagSummaries.join(". ") : stripHtml(trimmed);
  } else {
    summary = trimmed;
  }

  return truncateSummary(
    redactSensitiveErrorMessage(
      redactNetworkDetails(normalizeWhitespace(summary)),
    ),
  );
};

export interface FormattedSearchResult {
  title: string;
  url: string;
  content: string;
  date: string | null;
  lastUpdated: string | null;
}

/**
 * Build the request body for Perplexity Search API
 */
export const buildPerplexitySearchBody = (
  query: string | string[],
  options?: {
    country?: string;
    recency?: "day" | "week" | "month" | "year";
    maxResults?: number;
  },
): Record<string, unknown> => {
  const searchBody: Record<string, unknown> = {
    query,
    max_results: options?.maxResults ?? 10,
    max_tokens_per_page: SEARCH_RESULT_CONTENT_MAX_TOKENS,
  };

  if (options?.country) {
    searchBody.country = options.country;
  }

  if (options?.recency) {
    searchBody.search_recency_filter = options.recency;
  }

  return searchBody;
};

/**
 * Format Perplexity search results into a consistent structure
 */
export const formatSearchResults = (
  results: PerplexitySearchResult[],
): FormattedSearchResult[] => {
  return results.map((result) => ({
    title: result.title,
    url: result.url,
    content: result.snippet,
    date: result.date || null,
    lastUpdated: result.last_updated || null,
  }));
};
