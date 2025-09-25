import OpenAI from "openai";

const MODERATION_CHAR_LIMIT = 1000;

export async function getModerationResult(
  messages: any[],
  isPro: boolean,
): Promise<{ shouldUncensorResponse: boolean }> {
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!openaiApiKey) {
    return { shouldUncensorResponse: false };
  }

  const openai = new OpenAI({ apiKey: openaiApiKey });

  // Find the last user message that exceeds the minimum length
  const targetMessage = findTargetMessage(messages, 10);

  if (!targetMessage) {
    return { shouldUncensorResponse: false };
  }

  const input = prepareInput(targetMessage);

  try {
    const moderation = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: input,
    });

    // Check if moderation results exist and are not empty
    if (!moderation?.results || moderation.results.length === 0) {
      console.error("Moderation API returned no results");
      return { shouldUncensorResponse: false };
    }

    const result = moderation.results[0];
    const moderationLevel = calculateModerationLevel(result.category_scores);
    const hazardCategories = Object.entries(result.categories)
      .filter(([, isFlagged]) => isFlagged)
      .map(([category]) => category);

    const shouldUncensorResponse = determineShouldUncensorResponse(
      moderationLevel,
      hazardCategories,
      isPro,
    );

    // console.log(
    //   JSON.stringify(moderation, null, 2),
    //   moderationLevel,
    //   hazardCategories,
    //   shouldUncensorResponse,
    // );

    return { shouldUncensorResponse };
  } catch (_error: any) {
    // console.error('Error in getModerationResult:', error);
    return { shouldUncensorResponse: false };
  }
}

function findTargetMessage(messages: any[], minLength: number): any | null {
  let userMessagesChecked = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      userMessagesChecked++;

      // Handle UIMessage format with parts array
      if (message.parts && Array.isArray(message.parts)) {
        const textContent = message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");

        if (textContent.length > minLength) {
          return message;
        }
      }

      if (userMessagesChecked >= 3) {
        break; // Stop after checking three user messages
      }
    }
  }

  return null;
}

function prepareInput(message: any): string {
  // Handle UIMessage format with parts array
  if (message.parts && Array.isArray(message.parts)) {
    const textContent = message.parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text || "")
      .join(" ");

    return textContent.slice(0, MODERATION_CHAR_LIMIT);
  }
  // Fallback: Handle legacy string content format
  else if (typeof message.content === "string") {
    return message.content.slice(0, MODERATION_CHAR_LIMIT);
  }
  return "";
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
  isPro: boolean,
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
  const maxModerationLevel = 0.98;
  return (
    moderationLevel >= minModerationLevel &&
    moderationLevel <= maxModerationLevel &&
    !hasForbiddenCategory
  );
}
