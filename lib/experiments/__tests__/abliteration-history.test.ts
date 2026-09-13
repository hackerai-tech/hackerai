import {
  countIndependentAbliterationResponses,
  getAbliterationHistoryEntry,
  stripClientAbliterationRouting,
} from "../abliteration-history";

const entry = (
  id: string,
  source = "moderation",
  completed = true,
  finish_reason = "stop",
) =>
  getAbliterationHistoryEntry({
    id,
    finish_reason,
    usage: { abliterationRouting: { version: 1, source, completed } },
  });

describe("recent Abliteration history", () => {
  it("counts independent completed responses only, newest first", () => {
    expect(
      countIndependentAbliterationResponses([
        entry("incomplete", "moderation", true, "error"),
        entry("a"),
        entry("history", "history"),
        entry("fallback", "moderation", false),
        entry("b"),
      ]),
    ).toBe(2);
  });
  it("expires old seeds and never renews them from inherited responses", () => {
    expect(
      countIndependentAbliterationResponses([
        ...Array.from({ length: 4 }, (_, i) => entry(String(i), "history")),
        entry("a"),
        entry("b"),
      ]),
    ).toBe(1);
    expect(
      countIndependentAbliterationResponses([entry("a"), entry("a")]),
    ).toBe(1);
  });
  it("does not infer independent use from final model or unknown metadata", () => {
    for (const usage of [
      undefined,
      {},
      {
        abliterationRouting: {
          version: 2,
          source: "moderation",
          completed: true,
        },
      },
      { abliterationRouting: "moderation" },
    ]) {
      expect(
        getAbliterationHistoryEntry({ id: "a", finish_reason: "stop", usage })
          .independent,
      ).toBe(false);
    }
  });
  it("removes client routing claims without losing usage counters", () => {
    expect(
      stripClientAbliterationRouting({
        inputTokens: 12,
        abliterationRouting: {
          version: 1,
          source: "moderation",
          completed: true,
        },
      }),
    ).toEqual({ inputTokens: 12 });
  });
});
