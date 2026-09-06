export const ABLITERATION_MAX_CONVERSATIONAL_TURNS = 3;
export const ABLITERATION_CONVERSATION_TURN_COUNT_CAP =
  ABLITERATION_MAX_CONVERSATIONAL_TURNS + 1;

export function resolveAbliterationConversationTurn({
  persistedTurnCount,
  pendingUserTurnCount,
  regenerate,
  isAutoContinue,
}: {
  persistedTurnCount: number | undefined;
  pendingUserTurnCount: number;
  regenerate: boolean;
  isAutoContinue: boolean;
}): number | undefined {
  if (
    persistedTurnCount === undefined ||
    !Number.isInteger(persistedTurnCount) ||
    persistedTurnCount < 0 ||
    !Number.isInteger(pendingUserTurnCount) ||
    pendingUserTurnCount < 0
  )
    return undefined;

  const newTurnCount =
    !regenerate && !isAutoContinue ? pendingUserTurnCount : 0;
  return Math.min(
    ABLITERATION_CONVERSATION_TURN_COUNT_CAP,
    persistedTurnCount + newTurnCount,
  );
}
