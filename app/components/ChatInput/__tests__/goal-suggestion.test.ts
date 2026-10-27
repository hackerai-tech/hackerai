import { getGoalSuggestionDraft } from "../goal-suggestion";

describe("goal suggestion boundaries", () => {
  it.each([
    "Read https://example.com/goal",
    "Read /tmp/goal",
    "Read /goal.txt",
    "Explain /goals",
    "Explain /goalkeeper",
    "/goal pause",
    "/goal resume +2",
    "/goal start Create a marker",
    "  /goal Create a marker",
    "ordinary draft",
    "Calculate 12 / 3",
    "Compare desktop / mobile",
  ])("leaves %s to normal submission", (draft) => {
    expect(getGoalSuggestionDraft(draft)).toBeNull();
  });

  it.each(["/", "/g", "/go", "/goa", "/goal", " /GOAL "])(
    "supports the existing %s shortcut",
    (draft) => {
      expect(getGoalSuggestionDraft(draft)).toBe("");
    },
  );
  it("preserves division when selecting a later inline goal", () => {
    expect(getGoalSuggestionDraft("Calculate 12 / 3 /goal")).toBe(
      "Calculate 12 / 3",
    );
  });
});
