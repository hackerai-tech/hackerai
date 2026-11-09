import { describe, expect, it, jest } from "@jest/globals";
import registry from "../skills/strix-skill-catalog.generated.json";
import raw from "../skills/strix-skill-content.generated.json";
import {
  compileSubagentSkillContent,
  hasUnsupportedWorkerToolReference,
  hasBalancedCodeFences,
} from "../skills/runtime-content";
import { renderSubagentSkillKnowledge } from "../skills/knowledge";

const adapted = [
  "custom/dependency_cve_scanning",
  "custom/source_aware_sast",
  "custom/npx_confusion",
  "technologies/llm_applications",
];

describe("worker skill runtime compatibility", () => {
  it.each(adapted)(
    "loads %s without foreign reporting APIs or their schemas",
    (id) => {
      const rendered = renderSubagentSkillKnowledge([id]);
      expect(hasUnsupportedWorkerToolReference(rendered)).toBe(false);
      expect(hasBalancedCodeFences(rendered)).toBe(true);
      expect(rendered).toContain("HackerAI worker result contract");
      expect(rendered).toContain("active profile's provided tools");
      if (id === "custom/dependency_cve_scanning") {
        expect(rendered).toContain("trivy fs");
        expect(rendered).toContain("--list-all-pkgs");
        expect(rendered).toContain(".Results[].Packages[]");
        expect(rendered).toContain("DependsOn");
        expect(rendered).toContain("Relationship");
        expect(rendered).toContain("source-to-sink");
        expect(rendered).not.toContain("the tool rejects a report");
        expect(rendered).not.toContain("## Why this skill exists");
        expect(rendered).not.toContain(
          "### Reachability is a confidence modifier",
        );
        expect(rendered).not.toContain("## Anti-patterns");
      }
    },
  );
  it("rejects an adaptation that would leave a dangling scanner code block", () => {
    const skill = registry.skills.find((s) => s.id === adapted[0])!;
    const source = (raw.contents as Record<string, string>)[skill.id];
    const result = compileSubagentSkillContent(
      skill,
      source + "\n\n```bash\ncreate_agent\n\nstill code\n```\n",
    );
    expect(result).toEqual({
      success: false,
      error: "Skill adaptation left an incomplete code block",
    });
  });
  it("rejects unreviewed adapter revisions and unknown tool incompatibilities", () => {
    const skill = registry.skills.find((s) => s.id === adapted[0])!;
    const source = (raw.contents as Record<string, string>)[skill.id];
    expect(
      compileSubagentSkillContent(
        { ...skill, sourceSha256: "f".repeat(64) },
        source,
      ).success,
    ).toBe(false);
    expect(
      compileSubagentSkillContent(
        { id: "new/skill", sourceSha256: "f".repeat(64) },
        "Call create_agent to delegate this work.",
      ).success,
    ).toBe(false);
    expect(
      compileSubagentSkillContent(
        { id: "new/skill", sourceSha256: "f".repeat(64) },
        "Trace the actual authorization boundary.",
      ),
    ).toMatchObject({ success: true, adapted: false });
  });
  it("omits incompatible content from search/resolution and rejects loading it without disabling the library", () => {
    jest.doMock("../skills/strix-skill-content.generated.json", () => ({
      ...raw,
      contents: {
        ...raw.contents,
        "vulnerabilities/idor": "Call create_vulnerability_report directly.",
      },
    }));
    try {
      jest.isolateModules(() => {
        const skills = require("../skills");
        const tools = require("../../tools/subagent-skill-tools");
        expect(
          skills.resolveSubagentSkills(["vulnerabilities/idor"]).success,
        ).toBe(false);
        expect(
          tools.loadSubagentSkills({ skills: ["vulnerabilities/idor"] })
            .success,
        ).toBe(false);
        expect(
          tools
            .searchSubagentSkills({ query: "idor" })
            .results.some(
              (s: { id: string }) => s.id === "vulnerabilities/idor",
            ),
        ).toBe(false);
        expect(skills.resolveSubagentSkills(["cloud/aws"]).success).toBe(true);
        expect(skills.listIncompatibleSubagentSkills()).toContainEqual({
          id: "vulnerabilities/idor",
          error: "Skill references an unsupported worker tool",
        });
      });
    } finally {
      jest.dontMock("../skills/strix-skill-content.generated.json");
    }
  });
});
