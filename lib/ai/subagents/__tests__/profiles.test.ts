import { describe, expect, it } from "@jest/globals";

import {
  getSubagentProfileDefinition,
  resolveSubagentAllowedToolNames,
  resolveSubagentAllowedToolNamesForPermissionMode,
} from "../profiles";

describe("subagent profiles", () => {
  it.each(["general", "security_validation", "security_task"] as const)(
    "allows evidence correction without duplicate accepted results in %s",
    (name) => {
      const profile = getSubagentProfileDefinition(name);
      const instructions = [
        profile.buildSystemPrompt({ objective: "Test" }),
        profile.buildPrompt({ objective: "Test" }, []),
        profile.finalResultTool.description,
      ].join("\n");
      expect(instructions).toContain("retry once");
      expect(instructions).toContain("never resubmit after acceptance");
      expect(instructions).not.toContain("exactly once");
    },
  );
  it("gives every profile the same built-in subagent tools", () => {
    const profile = getSubagentProfileDefinition("general");
    expect(profile.finalResultTool.name).toBe("submit_task_result");
    expect(profile.systemPrompt).toContain("durable work ledger");
    expect(profile.systemPrompt).toContain("Never delegate another worker");
    expect(profile.systemPrompt).toContain(
      "Every child receives the same built-in subagent tools",
    );

    for (const name of [
      "general",
      "security_validation",
      "security_task",
    ] as const) {
      expect(resolveSubagentAllowedToolNames(name, ["code_read"])).toEqual(
        profile.allowedToolNames,
      );
      expect(resolveSubagentAllowedToolNames(name, ["code_write"])).toEqual(
        profile.allowedToolNames,
      );
    }
    expect(profile.allowedToolNames).toEqual([
      "run_terminal_cmd",
      "interact_terminal_session",
      "get_terminal_files",
      "file",
      "todo_write",
      "web_search",
      "open_url",
      "search_skills",
      "load_skill",
      "report_to_parent",
      "update_work_ledger",
    ]);
  });
  it("defines a generic security task with fixed tools and assigned skills", () => {
    const profile = getSubagentProfileDefinition("security_task");

    expect(profile.finalResultTool.name).toBe("submit_task_result");
    expect(profile.allowedToolNames).toEqual(
      getSubagentProfileDefinition("general").allowedToolNames,
    );
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

  it.each(["ask_approval", "auto_review", "full_access"] as const)(
    "preserves the shared child tools in %s mode",
    (permissionMode) => {
      expect(
        resolveSubagentAllowedToolNamesForPermissionMode(
          "general",
          ["code_write", "terminal", "browser_qa"],
          permissionMode,
        ),
      ).toEqual(getSubagentProfileDefinition("general").allowedToolNames);
    },
  );
});
