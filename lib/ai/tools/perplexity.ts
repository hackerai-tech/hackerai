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
