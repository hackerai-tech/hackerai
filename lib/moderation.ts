import OpenAI from "openai";
import { decode } from "gpt-tokenizer";
import { safeEncode } from "@/lib/token-utils";
import { detectLang, type SupportedLang } from "@/lib/chat/auth-disclaimer";

const MODERATION_TOKEN_LIMIT = 512;

export type ModerationResult = {
  shouldUncensorResponse: boolean;
  moderationText: string;
  language: SupportedLang;
};

const emptyModerationResult = (
  language: SupportedLang = "en",
): ModerationResult => ({
  shouldUncensorResponse: false,
  moderationText: "",
  language,
});

export async function getModerationResult(
  messages: any[],
  isPaidUser: boolean,
): Promise<ModerationResult> {
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    return emptyModerationResult();
  }

  const openai = new OpenAI({ apiKey: openaiApiKey });

  // Find the last user message that exceeds the minimum length
  const targetMessage = findTargetMessage(messages, 30);

  if (!targetMessage) {
    return emptyModerationResult();
  }

  const input = prepareInput(targetMessage);
  const language = detectLang(input);

  try {
    const moderation = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: input,
    });

    // Check if moderation results exist and are not empty
    if (!moderation?.results || moderation.results.length === 0) {
      console.error("Moderation API returned no results");
      return { shouldUncensorResponse: false, moderationText: input, language };
    }

    const result = moderation.results[0];
    const moderationLevel = calculateModerationLevel(result.category_scores);
    const hazardCategories = Object.entries(result.categories)
      .filter(([, isFlagged]) => isFlagged)
      .map(([category]) => category);

    const shouldUncensorResponse = determineShouldUncensorResponse(
      moderationLevel,
      hazardCategories,
      isPaidUser,
    );

    return { shouldUncensorResponse, moderationText: input, language };
  } catch (_error: any) {
    return emptyModerationResult(language);
  }
}

function findTargetMessage(messages: any[], minLength: number): any | null {
  const MIN_FALLBACK_LENGTH = 5;
  let combinedContent = "";
  let userMessagesChecked = 0;
  const messagesToCombine: any[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      userMessagesChecked++;
      messagesToCombine.push(message);

      // Handle UIMessage format with parts array
      if (message.parts && Array.isArray(message.parts)) {
        const textContent = message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");

        combinedContent = textContent + " " + combinedContent;
      }

      // Check if we've reached the minimum length
      if (combinedContent.trim().length >= minLength) {
        return createCombinedMessage(messagesToCombine);
      }

      if (userMessagesChecked >= 3) {
        break; // Stop after checking three user messages
      }
    }
  }

  // If we have some content but it's less than minLength, check if it's at least MIN_FALLBACK_LENGTH
  if (
    combinedContent.trim().length >= MIN_FALLBACK_LENGTH &&
    messagesToCombine.length > 0
  ) {
    return createCombinedMessage(messagesToCombine);
  }

  return null;
}

function createCombinedMessage(messages: any[]): any {
  const combinedParts: any[] = [];

  // Reverse to get chronological order
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.parts && Array.isArray(message.parts)) {
      const textParts = message.parts.filter(
        (part: any) => part.type === "text",
      );
      combinedParts.push(...textParts);
    }
  }

  return {
    role: "user",
    parts: combinedParts,
  };
}

function prepareInput(message: any): string {
  // Handle UIMessage format with parts array
  if (message.parts && Array.isArray(message.parts)) {
    const textContent = message.parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text || "")
      .join(" ");

    return truncateByTokens(textContent);
  }
  // Fallback: Handle legacy string content format
  else if (typeof message.content === "string") {
    return truncateByTokens(message.content);
  }
  return "";
}

function truncateByTokens(content: string): string {
  const tokens = safeEncode(content);
  if (tokens.length <= MODERATION_TOKEN_LIMIT) {
    return content;
  }

  // For large inputs, include both beginning and end for better context
  const halfLimit = Math.floor(MODERATION_TOKEN_LIMIT / 2);
  const startTokens = tokens.slice(0, halfLimit);
  const endTokens = tokens.slice(-halfLimit);

  return decode(startTokens) + " [...] " + decode(endTokens);
}

function calculateModerationLevel(
  categoryScores: OpenAI.Moderations.Moderation.CategoryScores,
): number {
  const maxScore = Math.max(
    ...Object.values(categoryScores).filter(
      (score): score is number => typeof score === "number",
    ),
  );
  return Math.min(Math.max(maxScore, 0), 1);
}

function determineShouldUncensorResponse(
  moderationLevel: number,
  hazardCategories: string[],
  isPaidUser: boolean,
): boolean {
  const forbiddenCategories = [
    "sexual",
    "sexual/minors",
    "hate",
    "hate/threatening",
    "harassment",
    "harassment/threatening",
    "self-harm",
    "self-harm/intent",
    "self-harm/instruction",
    "violence",
    "violence/graphic",
  ];
  const hasForbiddenCategory = hazardCategories.some((category) =>
    forbiddenCategories.includes(category),
  );

  // 0.1 is the minimum moderation level for the model to be used
  const minModerationLevel = 0.1;
  const maxModerationLevel = isPaidUser ? 0.98 : 0.9;
  return (
    moderationLevel >= minModerationLevel &&
    moderationLevel <= maxModerationLevel &&
    !hasForbiddenCategory
  );
}
