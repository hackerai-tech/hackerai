import { describe, expect, it } from "@jest/globals";

import { getSubagentProfileDefinition } from "../profiles";

describe("subagent profiles", () => {
  it("defines a generic profile whose tools come from server capability bundles", () => {
    const profile = getSubagentProfileDefinition("general");
    expect(profile.finalResultTool.name).toBe("submit_task_result");
    expect(profile.systemPrompt).toContain("durable work ledger");
    expect(profile.systemPrompt).toContain("Never delegate another worker");
  });
  it("defines a generic security task with fixed tools and assigned skills", () => {
    const profile = getSubagentProfileDefinition("security_task");

    expect(profile.finalResultTool.name).toBe("submit_task_result");
    expect(profile.allowedToolNames).toEqual([
      "run_terminal_cmd",
      "interact_terminal_session",
      "file",
      "web_search",
      "open_url",
      "search_skills",
      "load_skill",
    ]);
    expect(profile.systemPrompt).toContain("Never delegate another agent");
    expect(profile.systemPrompt).toContain(
      "No specialist skill content is loaded automatically",
    );
    expect(profile.systemPrompt).toContain(
      "consult its local version and help output",
    );
    expect(profile.systemPrompt).toContain("coverage entry");
    const row = {
      name: "Authorization mapper",
      objective: "Trace the endpoint authorization path.",
      success_criteria: ["Identify the enforcing function."],
      skills: ["vulnerabilities/idor"],
    };
    const systemPrompt = profile.buildSystemPrompt(row);
    const prompt = profile.buildPrompt(row, []);
    expect(prompt).toContain("1. Identify the enforcing function.");
    expect(prompt).not.toContain("## Skill: vulnerabilities/idor");
    expect(systemPrompt).toContain("## Skill: vulnerabilities/idor");
    expect(systemPrompt).toContain("Object-level authorization failures");
    expect(prompt).toContain("optional coverage array");
    expect(profile.buildSystemPrompt({ ...row, skills: [] })).not.toContain(
      "<specialized_knowledge>",
    );
  });

  it("keeps vulnerability confirmation in the validation profile", () => {
    const profile = getSubagentProfileDefinition("security_validation");
    expect(profile.finalResultTool.name).toBe("submit_validation_result");
    expect(profile.allowedToolNames).toContain("load_skill");
    expect(profile.buildSystemPrompt({ objective: "Validate" })).not.toContain(
      "<specialized_knowledge>",
    );
  });
});
