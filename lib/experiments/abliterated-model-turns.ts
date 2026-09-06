export const ABLITERATION_MAX_CONVERSATIONAL_TURNS = 3;
export const ABLITERATION_CONVERSATION_TURN_COUNT_CAP =
  ABLITERATION_MAX_CONVERSATIONAL_TURNS + 1;

/**
 * Normalizes a persisted fallback count used by regeneration and auto-continue.
 * New visible user messages receive their turn atomically during persistence.
 */
export function resolveAbliterationConversationTurn({
  persistedTurnCount,
}: {
  persistedTurnCount: number | undefined;
}): number | undefined {
  if (
    persistedTurnCount === undefined ||
    !Number.isInteger(persistedTurnCount) ||
    persistedTurnCount < 0
  )
    return undefined;

  return Math.min(ABLITERATION_CONVERSATION_TURN_COUNT_CAP, persistedTurnCount);
}
