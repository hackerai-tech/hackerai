import { tool } from "ai";
import { z } from "zod";
import type { BrowserSessions } from "./utils/browser-sessions";

export function createBrowserHandoff(
  sessions: BrowserSessions,
  signal?: AbortSignal,
) {
  return tool({
    description:
      "Wait for the user to take control of the open Cloud browser. Call this tool alone after opening the page and explaining the handoff. It keeps the Agent waiting until the user clicks Send and continue. Do not use shell sleep or polling commands to wait for a human. After it returns, read the private handoff context and take a fresh browser snapshot.",
    inputSchema: z.object({
      requestAnotherTakeover: z
        .boolean()
        .optional()
        .describe(
          "Set true only when the user explicitly requested another takeover after completing one. Omit for the initial handoff, retries, or when the user just exited takeover; those return the completed handoff without waiting again.",
        ),
    }),
    execute: async (input, options) => {
      const signals = [signal, options.abortSignal].filter(
        (value): value is AbortSignal => !!value,
      );
      await sessions.waitForHumanHandoff(
        signals.length ? AbortSignal.any(signals) : undefined,
        input.requestAnotherTakeover,
      );
      return {
        status: "resumed",
        message:
          "The user finished browser takeover. Read the private handoff context and take a fresh snapshot before any further browser action.",
      };
    },
  });
}
