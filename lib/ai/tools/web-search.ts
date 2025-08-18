import { tool } from "ai";
import { z } from "zod";
import Exa from "exa-js";
import { ToolContext } from "@/types";

/**
 * Web search tool using Exa API
 * Searches the web and returns results with content
 */
export const createWebSearchTool = (context: ToolContext) => {
  const { userLocation } = context;

  return tool({
    description: `Use the webSearch tool to access up-to-date information from the web \
or when responding to the user requires information about their location. \
Some examples of when to use the webSearch tool include:

- Local Information: Use the \`webSearch\` tool to respond to questions that require information \
about the user's location, such as the weather, local businesses, or events.
- Freshness: If up-to-date information on a topic could potentially change or enhance the answer, \
call the \`webSearch\` tool any time you would otherwise refuse to answer a question because your \
knowledge might be out of date.
- Niche Information: If the answer would benefit from detailed information not widely known or understood \
(which might be found on the internet), such as details about a small neighborhood, a less well-known \
company, or arcane regulations, use web sources directly rather than relying on the distilled knowledge \
from pretraining.
- Accuracy: If the cost of a small mistake or outdated information is high (e.g., using an outdated \
version of a software library or not knowing the date of the next game for a sports team), then use the \
\`webSearch\` tool.`,
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.",
        ),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
    }),
    execute: async ({ query }: { query: string }) => {
      try {
        const exa = new Exa(process.env.EXA_API_KEY);
        let result;

        try {
          // First attempt with default parameters
          result = await exa.searchAndContents(query, {
            type: "auto",
            text: {
              maxCharacters: 8000,
            },
            userLocation: userLocation.country,
          });
        } catch (firstError: any) {
          // If error mentions userLocation or country code, retry without userLocation
          if (
            firstError?.message?.includes("userLocation") ||
            firstError?.message?.includes("country code")
          ) {
            result = await exa.searchAndContents(query, {
              type: "auto",
              text: {
                maxCharacters: 8000,
              },
            });
          } else {
            throw firstError;
          }
        }

        // const searchCitations = result.results
        //   .map((item: any) => item.url)
        //   .filter((url: string) => url);

        // if (searchCitations.length > 0) {
        //   writer.write({
        //     type: "data-citation",
        //     data: { citations: searchCitations },
        //   });
        // }

        return result.results;
      } catch (error) {
        console.error("Exa web search error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return `Error performing web search: ${errorMessage}`;
      }
    },
  });
};
