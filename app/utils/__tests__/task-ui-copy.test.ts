import { formatTaskTitle, formatTaskUiCopy } from "../task-ui-copy";

describe("task UI copy", () => {
  it("relabels chat entities without changing the support channel", () => {
    expect(
      formatTaskUiCopy(
        "This chat failed. Please contact support via chat for help with your chats.",
      ),
    ).toBe(
      "This task failed. Please contact support via chat for help with your tasks.",
    );
  });

  it("only relabels the generated default title", () => {
    expect(formatTaskTitle("New Chat")).toBe("New Task");
    expect(formatTaskTitle("Review chat security")).toBe(
      "Review chat security",
    );
  });
});
