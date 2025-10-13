import { tool } from "ai";
import { z } from "zod";
import Exa from "exa-js";
import { ToolContext } from "@/types";
import { truncateContent } from "@/lib/token-utils";

/**
 * Web tool using Exa API for search and Jina AI for URL content retrieval
 * Provides search and URL opening capabilities
 */
export const createWebTool = (context: ToolContext) => {
  const { userLocation } = context;

  return tool({
    description: `Use the web tool to access up-to-date information from the web or when responding to the user requires information about their location. Some examples of when to use the web tool include:

Local Information: Use the web tool to respond to questions that require information about the user's location, such as the weather, local businesses, or events.
Freshness: If up-to-date information on a topic could potentially change or enhance the answer, call the web tool any time you would otherwise refuse to answer a question because your knowledge might be out of date.
Niche Information: If the answer would benefit from detailed information not widely known or understood (which might be found on the internet), such as details about a small neighborhood, a less well-known company, or arcane regulations, use web sources directly rather than relying on the distilled knowledge from pretraining.
Accuracy: If the cost of a small mistake or outdated information is high (e.g., using an outdated version of a software library or not knowing the date of the next game for a sports team), then use the web tool.

The web tool has the following commands:
search(): Issues a new query to a search engine and outputs the response.
open_url(url: str) Opens the given URL and displays it.`,
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
    execute: async ({
      command,
      query,
      url,
    }: {
      command: "search" | "open_url";
      query?: string;
      url?: string;
    }, { abortSignal }) => {
      try {
        if (command === "search") {
          const exa = new Exa(process.env.EXA_API_KEY);
          if (!query) {
            return "Error: Query is required for search command";
          }

          let result;

          try {
            // Safely access userLocation country
            const country = userLocation?.country;
            const searchOptions = {
              type: "auto" as const,
              text: {
                maxCharacters: 2000,
              },
              ...(country && { userLocation: country }),
            };

            // First attempt with location if available
            result = await exa.searchAndContents(query, searchOptions);
          } catch (firstError: any) {
            // Always retry without userLocation as fallback
            result = await exa.searchAndContents(query, {
              type: "auto",
              text: {
                maxCharacters: 2000,
              },
            });
          }

          return result.results;
        } else if (command === "open_url") {
          if (!url) {
            return "Error: URL is required for open_url command";
          }

          if (!process.env.JINA_API_KEY) {
            throw new Error("JINA_API_KEY environment variable is not set");
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
            },
            signal: abortSignal,
          });

          if (!response.ok) {
            const errorBody = await response.text();
            return `Error: HTTP ${response.status} - ${errorBody}`;
          }

          const content = await response.text();

          // Truncate content to 4096 tokens
          return truncateContent(content);
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
