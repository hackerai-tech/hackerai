import { tool } from "ai";
import { OPEN_URL_DESCRIPTION, OPEN_URL_INPUT_SCHEMA } from "./schemas";
import { openUrlImpl } from "./utils/web-impl";

/**
 * Open URL tool using Jina AI for content retrieval.
 * The shared `openUrlImpl` is also used by the durable workflow agent.
 */
export const createOpenUrlTool = () =>
  tool({
    description: OPEN_URL_DESCRIPTION,
    inputSchema: OPEN_URL_INPUT_SCHEMA,
    execute: async ({ url }: { url: string }, { abortSignal }) =>
      openUrlImpl({ url, abortSignal }),
  });
