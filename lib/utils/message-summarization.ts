import "server-only";

import {
  UIMessage,
  generateText,
  convertToModelMessages,
  LanguageModel,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { SubscriptionTier } from "@/types";

// Keep last N messages unsummarized for context
const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

// Summarize at 90% of token limit to leave buffer for current response
// This provides ~3.2k tokens (for 32k Pro plan) for assistant's response and summary
const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.9;

/**
 * Count tokens for ModelMessage array
 * Uses countPartTokens-like logic for each message content part
 * Excludes reasoning blocks to match token-utils.ts behavior
 */
const countModelMessageTokens = (messages: ModelMessage[]): number => {
  let totalTokens = 0;

  for (const message of messages) {
    // Count role tokens
    let messageTokens = countTokens(message.role);

    // Count content tokens based on type
    if (typeof message.content === "string") {
      messageTokens += countTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        // Skip reasoning parts (same as token-utils.ts)
        if (part.type === "reasoning") {
          continue;
        }

        if (part.type === "text") {
          messageTokens += countTokens(part.text || "");
        } else {
          // For tool-call, tool-result, image, etc., count their JSON structure
          messageTokens += countTokens(JSON.stringify(part));
        }
      }
    }

    totalTokens += messageTokens;
  }

  return totalTokens;
};

/**
 * Check and summarize messages if needed
 * This is the main entry point for the chat handler
 */
export const checkAndSummarizeIfNeeded = async (
  currentModelMessages: ModelMessage[],
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
): Promise<{
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
}> => {
  // Check if summarization is needed
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Count tokens using currentModelMessages (what's actually sent to AI)
  // This includes tool calls, tool results, and all content
  const totalTokens = countModelMessageTokens(currentModelMessages);
  const maxTokens = getMaxTokensForSubscription(subscription);
  const threshold = Math.floor(maxTokens * SUMMARIZATION_THRESHOLD_PERCENTAGE);

  if (totalTokens <= threshold) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Keep last N messages unsummarized
  const lastMessages = uiMessages.slice(-MESSAGES_TO_KEEP_UNSUMMARIZED);
  const messagesToSummarize = uiMessages.slice(
    0,
    -MESSAGES_TO_KEEP_UNSUMMARIZED,
  );

  if (messagesToSummarize.length === 0) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // The cutoff message ID is the last message that was summarized
  const cutoffMessageId =
    messagesToSummarize[messagesToSummarize.length - 1].id;

  // Generate summary using AI
  let summaryText: string;
  try {
    const result = await generateText({
      model: languageModel,
      system:
        "You are an agent performing context condensation for a security agent. Your job is to compress scan data while preserving ALL operationally critical information for continuing the security assessment.\n\n" +
        "CRITICAL ELEMENTS TO PRESERVE:\n" +
        "- Discovered vulnerabilities and potential attack vectors\n" +
        "- Scan results and tool outputs (compressed but maintaining key findings)\n" +
        "- Access credentials, tokens, or authentication details found\n" +
        "- System architecture insights and potential weak points\n" +
        "- Progress made in the assessment\n" +
        "- Failed attempts and dead ends (to avoid duplication)\n" +
        "- Any decisions made about the testing approach\n\n" +
        "COMPRESSION GUIDELINES:\n" +
        "- Preserve exact technical details (URLs, paths, parameters, payloads)\n" +
        "- Summarize verbose tool outputs while keeping critical findings\n" +
        "- Maintain version numbers, specific technologies identified\n" +
        "- Keep exact error messages that might indicate vulnerabilities\n" +
        "- Compress repetitive or similar findings into consolidated form\n\n" +
        "Remember: Another security agent will use this summary to continue the assessment. They must be able to pick up exactly where you left off without losing any operational advantage or context needed to find vulnerabilities.",
      messages: [
        ...convertToModelMessages(messagesToSummarize),
        {
          role: "user",
          content:
            "Provide a technically precise summary of the above conversation segment that preserves all operational security context while keeping the summary concise and to the point.",
        },
      ],
    });
    summaryText = result.text;
  } catch (error) {
    console.error("[Summarization] Failed to generate summary:", error);
    summaryText = `[Summary of ${messagesToSummarize.length} messages in conversation]`;
  }

  // Create summary message with XML tags
  const summaryMessage: UIMessage = {
    id: uuidv4(),
    role: "user",
    parts: [
      {
        type: "text",
        text: `<context_summary>\n${summaryText}\n</context_summary>`,
      },
    ],
  };

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
