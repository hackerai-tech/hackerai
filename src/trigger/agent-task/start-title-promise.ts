import type { UIMessage } from "ai";
import { generateTitleFromUserMessage } from "@/lib/actions";
import { isXaiSafetyError } from "@/lib/api/chat-stream-helpers";
import type { AgentStreamContext } from "./context";

export function startTitlePromise(
  messages: UIMessage[],
  options: {
    isNewChat: boolean;
    temporary: boolean;
    appendMetadata: AgentStreamContext["appendMetadata"];
  },
): Promise<string | undefined> {
  if (!options.isNewChat || options.temporary) {
    return Promise.resolve(undefined);
  }
  return (async () => {
    try {
      const chatTitle = await generateTitleFromUserMessage(messages);
      if (chatTitle) {
        await options.appendMetadata({
          type: "data-title",
          data: { chatTitle },
        });
      }
      return chatTitle;
    } catch (error) {
      if (!isXaiSafetyError(error)) {
        const { logger } = await import("@trigger.dev/sdk/v3");
        logger.warn("Failed to generate chat title", { error });
      }
      return undefined;
    }
  })();
}
