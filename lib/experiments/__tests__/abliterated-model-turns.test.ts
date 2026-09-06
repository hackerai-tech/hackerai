import {
  ABLITERATION_CONVERSATION_TURN_COUNT_CAP,
  ABLITERATION_MAX_CONVERSATIONAL_TURNS,
  resolveAbliterationConversationTurn,
} from "../abliterated-model-turns";

describe("resolveAbliterationConversationTurn", () => {
  it("adds the current unsaved user turn and caps later conversations", () => {
    expect(
      resolveAbliterationConversationTurn({
        persistedTurnCount: 2,
        pendingUserTurnCount: 1,
        regenerate: false,
        isAutoContinue: false,
      }),
    ).toBe(ABLITERATION_MAX_CONVERSATIONAL_TURNS);
    expect(
      resolveAbliterationConversationTurn({
        persistedTurnCount: 3,
        pendingUserTurnCount: 1,
        regenerate: false,
        isAutoContinue: false,
      }),
    ).toBe(ABLITERATION_CONVERSATION_TURN_COUNT_CAP);
  });

  it.each([
    { regenerate: true, isAutoContinue: false },
    { regenerate: false, isAutoContinue: true },
  ])("does not increment for $regenerate/$isAutoContinue", (request) => {
    expect(
      resolveAbliterationConversationTurn({
        persistedTurnCount: 3,
        pendingUserTurnCount: 1,
        ...request,
      }),
    ).toBe(3);
  });

  it("fails closed for missing or invalid counts", () => {
    for (const persistedTurnCount of [undefined, -1, 1.5]) {
      expect(
        resolveAbliterationConversationTurn({
          persistedTurnCount,
          pendingUserTurnCount: 1,
          regenerate: false,
          isAutoContinue: false,
        }),
      ).toBeUndefined();
    }
  });
});
