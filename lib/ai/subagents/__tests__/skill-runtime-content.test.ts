import { describe, expect, it, jest } from "@jest/globals";
import registry from "../skills/strix-skill-catalog.generated.json";
import raw from "../skills/strix-skill-content.generated.json";
import {
  compileSubagentSkillContent,
  hasUnsupportedWorkerToolReference,
  hasBalancedCodeFences,
} from "../skills/runtime-content";
import { renderSubagentSkillKnowledge } from "../skills/knowledge";
import {
  loadSubagentSkills,
  searchSubagentSkills,
} from "../../tools/subagent-skill-tools";

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
      if (id === "custom/npx_confusion")
        expect(rendered).not.toContain("## High-Signal Patterns");
      if (id === "technologies/llm_applications")
        expect(rendered).not.toContain("## Reproducibility and Reporting");
      if (id === "custom/source_aware_sast")
        expect(rendered).toContain(
          "Do not treat scanner output as final truth.",
        );
    },
  );
  it("keeps dependency analysis searchable and loadable with uncertainty preserved", () => {
    const id = "custom/dependency_cve_scanning";
    expect(
      searchSubagentSkills({ query: "dependency-cve-scanning" }).results,
    ).toContainEqual(expect.objectContaining({ id }));
    const loaded = loadSubagentSkills({ skills: [id] });
    expect(loaded.success).toBe(true);
    if (!loaded.success) throw new Error(loaded.error);
    expect(loaded.skills).toEqual([id]);
    expect(hasUnsupportedWorkerToolReference(loaded.content)).toBe(false);
    expect(hasBalancedCodeFences(loaded.content)).toBe(true);
    expect(loaded.content).toContain("incomplete or inconclusive analysis");
    expect(loaded.content).toContain("unknown");
    expect(loaded.content).toContain("cannot be inspected");
    expect(loaded.content).toContain(
      "all discovered import and affected-symbol call sites",
    );
    expect(loaded.content).not.toContain("`reachability_evidence`");
    expect(loaded.content).not.toContain("blob, a private bundle");
    expect(loaded.content).not.toContain(
      "named in the summary as not analyzed",
    );
    expect(loaded.content).toContain("Return every advisory-matched candidate");
    expect(loaded.content).not.toContain("There are three answers and no");
    expect(loaded.content).not.toContain(
      "or the only code that could use it cannot be inspected",
    );
    expect(loaded.content).toContain("inspect the code of the");
    expect(loaded.content).toContain(
      "package one hop above the vulnerable one",
    );
    expect(loaded.content).toContain("verdict is per CVE, not per package");
    expect(loaded.content).toContain("The parent decides what to report");
  });
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
