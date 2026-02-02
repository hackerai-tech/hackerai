import "server-only";

import {
  UIMessage,
  UIMessageStreamWriter,
  generateText,
  convertToModelMessages,
  LanguageModel,
  ModelMessage,
} from "ai";
import { v4 as uuidv4 } from "uuid";
import { getMaxTokensForSubscription } from "@/lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { SubscriptionTier, ChatMode } from "@/types";
import { stripProviderMetadataFromPart } from "@/lib/utils/message-processor";
import {
  writeSummarizationStarted,
  writeSummarizationCompleted,
} from "@/lib/utils/stream-writer-utils";
import { saveChatSummary } from "@/lib/db/actions";

// Keep last N messages unsummarized for context
const MESSAGES_TO_KEEP_UNSUMMARIZED = 2;

// Summarize at 90% of token limit to leave buffer for current response
const SUMMARIZATION_THRESHOLD_PERCENTAGE = 0.9;

const AGENT_SUMMARIZATION_PROMPT =
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
  "Remember: Another security agent will use this summary to continue the assessment. They must be able to pick up exactly where you left off without losing any operational advantage or context needed to find vulnerabilities.";

const ASK_SUMMARIZATION_PROMPT =
  "You are performing context condensation for a conversational assistant. Your job is to compress the conversation while preserving key information for continuity.\n\n" +
  "CRITICAL ELEMENTS TO PRESERVE:\n" +
  "- User's questions and the assistant's answers\n" +
  "- Key facts, decisions, and conclusions reached\n" +
  "- Any URLs, code snippets, or technical details shared\n" +
  "- User preferences or context mentioned\n" +
  "- Unresolved questions or ongoing threads\n\n" +
  "COMPRESSION GUIDELINES:\n" +
  "- Preserve exact technical details when relevant\n" +
  "- Summarize repetitive exchanges into consolidated form\n" +
  "- Maintain the conversational flow and context\n" +
  "- Keep user-stated goals and requirements\n\n" +
  "Remember: The assistant will use this summary to continue helping the user seamlessly.";

const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;

/**
 * Count tokens for ModelMessage array.
 * Excludes reasoning blocks and strips provider-specific fields before counting.
 */
const countModelMessageTokens = (messages: ModelMessage[]): number => {
  let totalTokens = 0;

  for (const message of messages) {
    if (typeof message.content === "string") {
      totalTokens += countTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        // Skip reasoning parts
        if (part.type === "reasoning") {
          continue;
        }

        if (part.type === "text") {
          totalTokens += countTokens(part.text || "");
        } else {
          // Strip provider fields before counting (providerMetadata, providerOptions, etc.)
          const cleanPart = stripProviderMetadataFromPart(part);
          totalTokens += countTokens(JSON.stringify(cleanPart));
        }
      }
    }
  }

  return totalTokens;
};

/**
 * Check and summarize messages if needed
 * This is the main entry point for the chat handler
 * Handles the full summarization flow: check -> shimmer -> generate -> save -> complete
 * @param writer - Stream writer for sending status updates to the client
 * @param chatId - Chat ID for saving the summary (null for temporary chats)
 */
export const checkAndSummarizeIfNeeded = async (
  currentModelMessages: ModelMessage[],
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
  writer: UIMessageStreamWriter,
  chatId: string | null,
): Promise<{
  needsSummarization: boolean;
  summarizedMessages: UIMessage[];
  cutoffMessageId: string | null;
  summaryText: string | null;
}> => {
  // Early return if not enough messages to summarize
  if (uiMessages.length <= MESSAGES_TO_KEEP_UNSUMMARIZED) {
    return {
      needsSummarization: false,
      summarizedMessages: uiMessages,
      cutoffMessageId: null,
      summaryText: null,
    };
  }

  // Count tokens and check against threshold
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

  // Show shimmer indicator BEFORE generating summary
  writeSummarizationStarted(writer);

  // Generate summary using AI
  let summaryText: string;
  try {
    const result = await generateText({
      model: languageModel,
      system: getSummarizationPrompt(mode),
      providerOptions: {
        xai: {
          // Disable storing the conversation in XAI's database
          store: false,
        },
      },
      messages: [
        ...(await convertToModelMessages(messagesToSummarize)),
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

  // Save the summary to the database (non-temporary chats only)
  if (chatId) {
    try {
      await saveChatSummary({
        chatId,
        summaryText,
        summaryUpToMessageId: cutoffMessageId,
      });
    } catch (error) {
      console.error("[Summarization] Failed to save summary:", error);
      // Continue anyway - the summary was generated successfully
    }
  }

  // Always write completed status to clear UI shimmer
  writeSummarizationCompleted(writer);

  return {
    needsSummarization: true,
    summarizedMessages: [summaryMessage, ...lastMessages],
    cutoffMessageId,
    summaryText,
  };
};
