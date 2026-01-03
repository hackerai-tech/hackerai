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
    description: `Use the \`web\` tool to access up-to-date information from the web or when responding to the user requires information about their location. Some examples of when to use the \`web\` tool include:

- Local Information: Use the \`web\` tool to respond to questions that require information about the user's location, such as the weather, local businesses, or events.
- Freshness: If up-to-date information on a topic could potentially change or enhance the answer, call the \`web\` tool any time you would otherwise refuse to answer a question because your knowledge might be out of date.
- Niche Information: If the answer would benefit from detailed information not widely known or understood (which might be found on the internet), such as details about a small neighborhood, a less well-known company, or arcane regulations, use web sources directly rather than relying on the distilled knowledge from pretraining.
- Accuracy: If the cost of a small mistake or outdated information is high (e.g., using an outdated version of a software library or not knowing the date of the next game for a sports team), then use the \`web\` tool.

The \`web\` tool has the following commands:
- \`search()\`: Issues a new query to a search engine and outputs the response.
- \`open_url(url: str)\` Opens the given URL and displays it.`,
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
        url,
      }: {
        command: "search" | "open_url";
        query?: string;
        url?: string;
      },
      { abortSignal },
    ) => {
      try {
        if (command === "search") {
          if (!query) {
            return "Error: Query is required for search command";
          }

          let searchResults;

          try {
            // Safely access userLocation country
            const country = userLocation?.country;
            const searchBody: any = {
              query,
              type: "auto",
              numResults: 10,
            };

            if (country) {
              searchBody.userLocation = country;
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
            const response = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.EXA_API_KEY || "",
              },
              body: JSON.stringify({
                query,
                type: "auto",
                numResults: 10,
              }),
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
