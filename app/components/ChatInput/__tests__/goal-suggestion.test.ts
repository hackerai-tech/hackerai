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
  ])("leaves %s to normal submission", (draft) => {
    expect(getGoalSuggestionDraft(draft)).toBeNull();
  });

  it.each(["/", "/g", "/go", "/goa", "/goal", " /GOAL "])(
    "supports the existing %s shortcut",
    (draft) => {
      expect(getGoalSuggestionDraft(draft)).toBe("");
    },
  );
});
