import { tool } from "ai";
import { z } from "zod";
import { ToolContext } from "@/types";
import {
  PerplexitySearchResult,
  PerplexitySearchResponse,
  RECENCY_MAP,
  buildPerplexitySearchBody,
  formatSearchResults,
} from "./utils/perplexity";

/**
 * Web search tool using Perplexity Search API
 * Provides ranked web search results with content extraction
 */
export const createWebSearch = (context: ToolContext) => {
  const { userLocation } = context;

  return tool({
    description: `Search for information across various sources.

<instructions>
- MUST use this tool to access up-to-date or external information when needed; DO NOT rely solely on internal knowledge
- Each search MUST contain exactly 1 to 3 \`queries\` (NEVER more than 3). Queries MUST be variants of the same intent (i.e., query expansions), NOT different goals
- For non-English queries, MUST include at least one English query as the final variant to expand coverage
- For complex searches, MUST break down into step-by-step searches instead of using a single complex query
- Access multiple URLs from search results for comprehensive information or cross-validation
- CAN use Google dork syntax (site:, filetype:, inurl:, intitle:, etc.) for targeted reconnaissance and pentest enumeration
- Only use \`time\` parameter when explicitly required by task, otherwise leave time range unrestricted
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
- For commands/installations, prioritize Kali Linux compatibility using apt or pre-installed tools
</instructions>`,
    inputSchema: z.object({
      queries: z
        .array(z.string())
        .min(1)
        .max(3)
        .describe(
          "MAXIMUM 3 query variants (1-3 items only). Express the same search intent with different wording.",
        ),
      time: z
        .enum(["all", "past_day", "past_week", "past_month", "past_year"])
        .optional()
        .describe(
          "Optional time filter to limit results to a recent time range",
        ),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
    }),
    execute: async (
      {
        queries: rawQueries,
        time,
      }: {
        explanation: string;
        queries: string[];
        time?: "all" | "past_day" | "past_week" | "past_month" | "past_year";
      },
      { abortSignal },
    ) => {
      try {
        // Defensively cap at 3 queries in case the model sends more
        const queries = rawQueries.slice(0, 3);

        const searchBody = buildPerplexitySearchBody(
          queries.length === 1 ? queries[0] : queries,
          {
            country: userLocation?.country,
            recency: time && time !== "all" ? RECENCY_MAP[time] : undefined,
          },
        );

        const response = await fetch("https://api.perplexity.ai/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY || ""}`,
          },
          body: JSON.stringify(searchBody),
          signal: abortSignal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Perplexity API error: ${response.status} - ${errorText}`,
          );
        }

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
        console.error("Web search tool error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return `Error performing web search: ${errorMessage}`;
      }
    },
  });
};
