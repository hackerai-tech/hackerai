import { tool } from "ai";
import { z } from "zod";
import { ToolContext } from "@/types";
import { truncateContent, sliceByTokens } from "@/lib/token-utils";

// Max tokens per search result content field (recommended: 100-300 tokens per result)
const SEARCH_RESULT_CONTENT_MAX_TOKENS = 250;

/**
 * Web tool using Exa API for search and Jina AI for URL content retrieval
 * Provides search and URL opening capabilities
 */
export const createWebTool = (context: ToolContext) => {
  const { userLocation } = context;

  return tool({
    description: `Search and retrieve live, external internet information to answer time-sensitive or verifiable questions.

<supported_actions>
- \`search\`: Query a web search engine and return relevant sources with content snippets
- \`open_url\`: Retrieve the full contents of a specific webpage by URL
</supported_actions>

<instructions>
- Use \`search\` when information may be recent, changing, or requires verification
- Use \`open_url\` to fetch and read a specific webpage, usually obtained from a prior search
- \`recency\` optionally biases results toward more recent sources (past_day, past_week, past_month, past_year)
- Search queries can include operators like site:reddit.com, filetype:pdf, or exact phrases in quotes
- URLs passed to \`open_url\` must be valid and publicly accessible
- All factual statements derived from this tool must be cited in the final answer
</instructions>

<recommended_usage>
- Use \`search\` for news, current events, prices, schedules, policies, documentation, or announcements
- Use \`search\` for location-based queries like weather, local businesses, or events
- Use \`open_url\` to extract details from official pages, press releases, or primary sources
- Prefer multiple narrow searches over a single broad query
- Cross-check facts using more than one source when accuracy is critical
- Use when up-to-date information could change or enhance the answer
- Use for niche information not widely known (small businesses, arcane regulations, lesser-known topics)
</recommended_usage>`,
    inputSchema: z.object({
      command: z
        .enum(["search", "open_url"])
        .describe(
          "The command to execute: 'search' to search the web, 'open_url' to open a specific URL",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "For search command: The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.",
        ),
      recency: z
        .enum(["all", "past_day", "past_week", "past_month", "past_year"])
        .optional()
        .describe(
          "For search command: Optional time filter to limit results to a recent time range. Defaults to 'all'.",
        ),
      url: z
        .string()
        .optional()
        .describe(
          "For open_url command: The URL to open and retrieve content from",
        ),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
    }),
    execute: async (
      {
        command,
        query,
        recency,
        url,
      }: {
        command: "search" | "open_url";
        query?: string;
        recency?: "all" | "past_day" | "past_week" | "past_month" | "past_year";
        url?: string;
      },
      { abortSignal },
    ) => {
      try {
        if (command === "search") {
          if (!query) {
            return "Error: Query is required for search command";
          }

          // Calculate startPublishedDate based on recency enum
          const recencyToDays: Record<string, number> = {
            past_day: 1,
            past_week: 7,
            past_month: 30,
            past_year: 365,
          };
          const days = recency ? recencyToDays[recency] : undefined;
          const startPublishedDate = days
            ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
            : undefined;

          let searchResults;

          try {
            // Safely access userLocation country
            const country = userLocation?.country;
            const searchBody: Record<string, unknown> = {
              query,
              type: "auto",
              numResults: 10,
            };

            if (country) {
              searchBody.userLocation = country;
            }

            if (startPublishedDate) {
              searchBody.startPublishedDate = startPublishedDate;
            }

            // First attempt with location if available
            const response = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.EXA_API_KEY || "",
              },
              body: JSON.stringify(searchBody),
              signal: abortSignal,
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(
                `Exa API error: ${response.status} - ${errorText}`,
              );
            }

            searchResults = await response.json();
          } catch (firstError: unknown) {
            // Don't retry if the operation was aborted
            if (
              firstError instanceof Error &&
              firstError.name === "AbortError"
            ) {
              throw firstError;
            }
            // Retry without userLocation as fallback
            const fallbackBody: Record<string, unknown> = {
              query,
              type: "auto",
              numResults: 10,
            };

            if (startPublishedDate) {
              fallbackBody.startPublishedDate = startPublishedDate;
            }

            const response = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.EXA_API_KEY || "",
              },
              body: JSON.stringify(fallbackBody),
              signal: abortSignal,
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(
                `Exa API error: ${response.status} - ${errorText}`,
              );
            }

            searchResults = await response.json();
          }

          // Extract URLs from Exa results
          const urls = searchResults.results.map((result: any) => result.url);

          // Fetch content for each URL using Jina AI (runs in parallel)
          const contentPromises = urls.map(async (url: string) => {
            try {
              const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
              const response = await fetch(jinaUrl, {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${process.env.JINA_API_KEY}`,
                  "X-Engine": "direct",
                  "X-Timeout": "10",
                  "X-Base": "final",
                  "X-Token-Budget": "200000",
                },
                signal: abortSignal,
              });

              if (!response.ok) {
                return null;
              }

              const content = await response.text();
              const truncatedContent = sliceByTokens(
                content,
                SEARCH_RESULT_CONTENT_MAX_TOKENS,
              );

              return {
                url,
                content: truncatedContent,
              };
            } catch (error) {
              return null;
            }
          });

          const contents = await Promise.all(contentPromises);

          // Add text content to Exa results (exclude id, favicon, and null fields from Exa)
          const results = searchResults.results.map(
            (result: any, index: number) => {
              const contentData = contents[index];
              const { id, favicon, ...cleanResult } = result;

              // Filter out null/undefined values from Exa results only
              const filteredExaResult = Object.fromEntries(
                Object.entries(cleanResult).filter(
                  ([_, value]) => value !== null && value !== undefined,
                ),
              );

              // Add text field (can be null)
              return {
                ...filteredExaResult,
                text: contentData?.content || null,
              };
            },
          );

          return results;
        } else if (command === "open_url") {
          if (!url) {
            return "Error: URL is required for open_url command";
          }

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
            return `Error: HTTP ${response.status} - ${errorBody}`;
          }

          const content = await response.text();
          const truncated = truncateContent(content);

          return truncated;
        }

        return "Error: Invalid command";
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (error instanceof Error && error.name === "AbortError") {
          return "Error: Operation aborted";
        }
        console.error("Web tool error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return `Error performing web operation: ${errorMessage}`;
      }
    },
  });
};
