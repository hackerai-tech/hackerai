/**
 * Pure async wrappers around the Perplexity (web search) and Jina (open URL)
 * APIs. Both the AI-SDK factories and the workflow steps call into these so
 * the model-facing response shape stays in one place.
 *
 * Note: `webSearchImpl` does NOT report cost — the AI-SDK factory layer is
 * responsible for invoking `onToolCost` (which depends on the per-request
 * usage tracker that exists only in the chat-handler scope, not in the
 * durable workflow scope where the run is Pro-gated and reconciled later).
 */
import {
  type PerplexitySearchResult,
  type PerplexitySearchResponse,
  type FormattedSearchResult,
  RECENCY_MAP,
  buildPerplexitySearchBody,
  formatSearchResults,
} from "./perplexity";
import { truncateContent } from "@/lib/token-utils";

export type WebSearchTimeFilter =
  | "all"
  | "past_day"
  | "past_week"
  | "past_month"
  | "past_year";

export async function webSearchImpl(args: {
  queries: string[];
  time?: WebSearchTimeFilter;
  userLocationCountry?: string;
  abortSignal?: AbortSignal;
}): Promise<FormattedSearchResult[] | string> {
  try {
    const queries = args.queries.slice(0, 3);
    const searchBody = buildPerplexitySearchBody(
      queries.length === 1 ? queries[0] : queries,
      {
        country: args.userLocationCountry,
        recency:
          args.time && args.time !== "all" ? RECENCY_MAP[args.time] : undefined,
      },
    );

    const response = await fetch("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY || ""}`,
      },
      body: JSON.stringify(searchBody),
      signal: args.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `Error performing web search: Perplexity API error: ${response.status} - ${errorText}`;
    }

    const searchResponse: PerplexitySearchResponse = await response.json();

    const isMultiQuery = queries.length > 1;
    const allResults: PerplexitySearchResult[] =
      isMultiQuery && Array.isArray(searchResponse.results[0])
        ? (searchResponse.results as PerplexitySearchResult[][]).flat()
        : (searchResponse.results as PerplexitySearchResult[]);

    return formatSearchResults(allResults);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "Error: Operation aborted";
    }
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return `Error performing web search: ${message}`;
  }
}

export async function openUrlImpl(args: {
  url: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  try {
    const jinaUrl = `https://r.jina.ai/${encodeURIComponent(args.url)}`;
    const response = await fetch(jinaUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.JINA_API_KEY ?? ""}`,
        "X-Timeout": "30",
        "X-Base": "final",
        "X-Token-Budget": "200000",
      },
      signal: args.abortSignal,
    });
    if (!response.ok) {
      const body = await response.text();
      return `Error: HTTP ${response.status} - ${body}`;
    }
    const content = await response.text();
    return truncateContent(content, undefined, 2048);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "Error: Operation aborted";
    }
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return `Error opening URL: ${message}`;
  }
}
