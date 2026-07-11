import {
  MAX_MESSAGE_SEARCH_QUERY_LENGTH,
  splitTextBySearchTerm,
} from "../message-search";

describe("splitTextBySearchTerm", () => {
  it("treats regular expression syntax as literal text", () => {
    expect(splitTextBySearchTerm("Use [a-z]+ here", "[a-z]+")).toEqual([
      { text: "Use ", isMatch: false },
      { text: "[a-z]+", isMatch: true },
      { text: " here", isMatch: false },
    ]);
  });

  it("matches case-insensitively while preserving original text", () => {
    expect(splitTextBySearchTerm("HackerAI hackerai", "hackerai")).toEqual([
      { text: "HackerAI", isMatch: true },
      { text: " ", isMatch: false },
      { text: "hackerai", isMatch: true },
    ]);
  });

  it("does not process oversized pasted input", () => {
    const oversizedQuery = "(".repeat(MAX_MESSAGE_SEARCH_QUERY_LENGTH + 1);

    expect(splitTextBySearchTerm("safe result", oversizedQuery)).toEqual([
      { text: "safe result", isMatch: false },
    ]);
  });
});
