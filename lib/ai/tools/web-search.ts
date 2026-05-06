import { tool } from "ai";
import { ToolContext } from "@/types";
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_INPUT_SCHEMA } from "./schemas";
import { webSearchImpl, type WebSearchTimeFilter } from "./utils/web-impl";

/** Perplexity Search API cost: $5 per 1K requests */
export const WEB_SEARCH_COST_PER_REQUEST = 0.005;

/**
 * Web search tool using Perplexity Search API.
 * The chat-handler-scoped factory adds usage-tracker cost reporting on top
 * of the shared `webSearchImpl` (which is also used by the durable workflow
 * agent — there cost is reconciled separately at run end).
 */
export const createWebSearch = (context: ToolContext) => {
  const { userLocation, onToolCost } = context;

  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: WEB_SEARCH_INPUT_SCHEMA,
    execute: async (
      {
        queries,
        time,
      }: {
        brief: string;
        queries: string[];
        time?: WebSearchTimeFilter;
      },
      { abortSignal },
    ) => {
      const result = await webSearchImpl({
        queries,
        time,
        userLocationCountry: userLocation?.country,
        abortSignal,
      });
      // `webSearchImpl` returns an array on success, a string on error.
      // Only charge the user when the request actually returned results.
      if (Array.isArray(result)) {
        onToolCost?.(WEB_SEARCH_COST_PER_REQUEST);
      }
      return result;
    },
  });
};
