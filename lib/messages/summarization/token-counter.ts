import type { ModelMessage } from "ai";
import { countTokens } from "gpt-tokenizer";
import { stripProviderMetadataFromPart } from "@/lib/utils/message-processor";

/**
 * Count tokens for ModelMessage array.
 * Excludes reasoning blocks and strips provider-specific fields before counting.
 */
export const countModelMessageTokens = (messages: ModelMessage[]): number => {
  let totalTokens = 0;

  for (const message of messages) {
    if (typeof message.content === "string") {
      totalTokens += countTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "reasoning") {
          continue;
        }

        if (part.type === "text") {
          totalTokens += countTokens(part.text || "");
        } else {
          const cleanPart = stripProviderMetadataFromPart(part);
          totalTokens += countTokens(JSON.stringify(cleanPart));
        }
      }
    }
  }

  return totalTokens;
};
