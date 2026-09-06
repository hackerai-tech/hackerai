import {
  ABLITERATION_CONVERSATION_TURN_COUNT_CAP,
  resolveAbliterationConversationTurn,
} from "../abliterated-model-turns";

describe("resolveAbliterationConversationTurn", () => {
  it("preserves a persisted early-turn count", () => {
    expect(resolveAbliterationConversationTurn({ persistedTurnCount: 2 })).toBe(
      2,
    );
  });

  it("caps persisted counts one turn beyond the experiment limit", () => {
    expect(
      resolveAbliterationConversationTurn({
        persistedTurnCount: ABLITERATION_CONVERSATION_TURN_COUNT_CAP + 1,
      }),
    ).toBe(ABLITERATION_CONVERSATION_TURN_COUNT_CAP);
  });

  it("fails closed for missing or invalid counts", () => {
    for (const persistedTurnCount of [undefined, -1, 1.5]) {
      expect(
        resolveAbliterationConversationTurn({ persistedTurnCount }),
      ).toBeUndefined();
    }
  });
});
