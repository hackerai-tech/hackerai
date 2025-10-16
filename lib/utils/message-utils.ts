/**
 * Utility functions for processing message parts
 */

export interface MessagePart {
  type: string;
  text?: string;
}

/**
 * Extracts text content from message parts
 */
export const extractMessageText = (parts: MessagePart[]): string => {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("");
};

/**
 * Checks if message parts contain any text content
 */
export const hasTextContent = (parts: MessagePart[]): boolean => {
  return parts.some(
    (part) =>
      (part.type === "text" && part.text && part.text.trim() !== "") ||
      part.type === "step-start" ||
      part.type.startsWith("tool-"),
  );
};

/**
 * Finds the index of the last assistant message
 */
export const findLastAssistantMessageIndex = (
  messages: Array<{ role: "user" | "assistant" | "system" }>,
): number | undefined => {
  return messages
    .map((msg, index) => ({ msg, index }))
    .reverse()
    .find(({ msg }) => msg.role === "assistant")?.index;
};

/**
 * Represents a citation/source extracted from web tool outputs
 */
export type WebSource = {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
};

/**
 * Extract web sources from a message's tool outputs.
 * Handles both new `tool-web` and legacy `tool-web_search` parts
 * and flexible output shapes: array, { result: [] }, or { results: [] }.
 */
export const extractWebSourcesFromMessage = (message: {
  parts?: Array<any>;
}): Array<WebSource> => {
  const sources: Array<WebSource> = [];

  const parts: Array<any> = Array.isArray((message as any)?.parts)
    ? (message as any).parts
    : [];

  for (const part of parts) {
    if (part?.type === "tool-web" || part?.type === "tool-web_search") {
      if (part.state !== "output-available") continue;
      const output = part.output;

      let results: any = undefined;
      if (Array.isArray(output)) {
        results = output;
      } else if (Array.isArray(output?.result)) {
        results = output.result;
      } else if (Array.isArray(output?.results)) {
        results = output.results;
      }

      if (Array.isArray(results)) {
        for (const r of results) {
          const url = r?.url || r?.id;
          if (!url || typeof url !== "string") continue;
          sources.push({
            title: r?.title,
            url,
            text: r?.text,
            publishedDate: r?.publishedDate,
          });
        }
      }
    }
  }

  return sources;
};
