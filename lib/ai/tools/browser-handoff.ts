import { tool } from "ai";
import { z } from "zod";
import type { BrowserSessions } from "./utils/browser-sessions";

export function createBrowserHandoff(
  sessions: BrowserSessions,
  signal?: AbortSignal,
) {
  return tool({
    description:
      "Request human input in the open Cloud browser and pause the Agent. Use when the user must complete a login, verification, or other step requiring their interaction, or explicitly asks to take control. Do not call merely because you opened a browser or are browsing public pages. The UI shows a prominent Take control prompt only while waiting for input; normal browser access stays compact. Call this tool alone after opening the page and explaining exactly what the user needs to do. You MUST call it before ending a response that asks the user to interact with this browser; saying you are waiting without calling it closes the browser session. It keeps the Agent waiting until the user clicks Send and continue. Do not use shell sleep or polling commands to wait for a human. After it returns, read the private handoff context and take a fresh browser snapshot.",
    inputSchema: z.object({
      requestAnotherTakeover: z
        .boolean()
        .optional()
        .describe(
          "Set true only for a distinct new step requiring human input after a completed takeover, or when the user explicitly requests another takeover. First inspect the resumed page and explain the new need. Omit for the initial handoff, retries, or immediately after the user exits takeover; those return the completed handoff without waiting again.",
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
          "The user finished browser takeover. Read the private handoff context, then run agent-browser snapshot -i as the first browser command in the same session. Do not prepend get url, reopen the page, switch sessions, or repair the browser. The current page and user input are preserved. Inspect the snapshot before deciding the next action.",
      };
    },
  });
}
