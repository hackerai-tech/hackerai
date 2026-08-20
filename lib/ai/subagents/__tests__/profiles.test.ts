import { describe, expect, it } from "@jest/globals";

import { getSubagentProfileDefinition } from "../profiles";

describe("subagent profiles", () => {
  it("defines a generic security task with fixed tools and no skills", () => {
    const profile = getSubagentProfileDefinition("security_task");

    expect(profile.finalResultTool.name).toBe("submit_task_result");
    expect(profile.allowedToolNames).toEqual([
      "run_terminal_cmd",
      "interact_terminal_session",
      "file",
      "web_search",
      "open_url",
    ]);
    expect(profile.systemPrompt).toContain("Never delegate another agent");
    expect(profile.systemPrompt).toContain("load skills");
    expect(
      profile.buildPrompt(
        {
          name: "Authorization mapper",
          objective: "Trace the endpoint authorization path.",
          success_criteria: ["Identify the enforcing function."],
        },
        [],
      ),
    ).toContain("1. Identify the enforcing function.");
  });

  it("keeps vulnerability confirmation in the validation profile", () => {
    expect(
      getSubagentProfileDefinition("security_validation").finalResultTool.name,
    ).toBe("submit_validation_result");
  });
});
