import { getActionText } from "../computer-sidebar-utils";

describe("terminal Computer sidebar labels", () => {
  const terminal = {
    command: "wafw00f https://hackerone.com",
    output: "",
    isExecuting: false,
    toolCallId: "call-1",
  };

  it("labels review without implying the command is executing", () => {
    expect(getActionText({ ...terminal, executionPhase: "reviewing" })).toBe(
      "Reviewing",
    );
    expect(
      getActionText({ ...terminal, executionPhase: "awaiting_approval" }),
    ).toBe("Awaiting approval");
  });
});
