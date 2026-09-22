import type { UIMessage } from "ai";
import { hasCompletedAssistantText } from "../free-activation";

describe("completed response activation", () => {
  const reply = (id: string, text: string): UIMessage => ({
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  });
  it("requires text from the current assistant reply", () => {
    expect(
      hasCompletedAssistantText(
        [reply("old", "previous answer"), reply("new", "  ")],
        "new",
      ),
    ).toBe(false);
    expect(hasCompletedAssistantText([reply("new", "answer")], "new")).toBe(
      true,
    );
  });
  it("does not count tool output, user input, or an absent reply", () => {
    expect(
      hasCompletedAssistantText(
        [
          {
            id: "new",
            role: "user",
            parts: [{ type: "text", text: "request" }],
          },
        ],
        "new",
      ),
    ).toBe(false);
    expect(
      hasCompletedAssistantText(
        [{ id: "new", role: "assistant", parts: [{ type: "step-start" }] }],
        "new",
      ),
    ).toBe(false);
    expect(hasCompletedAssistantText([], "new")).toBe(false);
  });
});
