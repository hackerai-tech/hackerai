import { describe, expect, it } from "@jest/globals";
import upstreamManifest from "@/third_party/strix-skills/UPSTREAM.json";

import {
  STRIX_SUBAGENT_SKILL_COUNT,
  STRIX_SUBAGENT_SKILL_SOURCE_COMMIT,
  getSubagentSkillCatalogPrompt,
  listSubagentSkills,
  resolveSubagentSkills,
} from "../skills";
import { renderSubagentSkillKnowledge } from "../skills/knowledge";

describe("Strix subagent skills", () => {
  it("exposes the vendored selectable catalog without internal orchestration skills", () => {
    expect(STRIX_SUBAGENT_SKILL_COUNT).toBe(
      upstreamManifest.selectableSkillCount,
    );
    expect(STRIX_SUBAGENT_SKILL_COUNT).toBeGreaterThan(0);
    expect(STRIX_SUBAGENT_SKILL_SOURCE_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(
      listSubagentSkills().some((skill) => skill.id === "vulnerabilities/idor"),
    ).toBe(true);
    expect(
      listSubagentSkills().some(
        (skill) => skill.id === "analysis/counterevidence",
      ),
    ).toBe(false);
  });

  it("resolves qualified ids and unambiguous Strix aliases", () => {
    expect(resolveSubagentSkills(["vulnerabilities/idor"])).toMatchObject({
      success: true,
      skills: [{ id: "vulnerabilities/idor" }],
    });
    expect(resolveSubagentSkills(["idor"])).toMatchObject({
      success: true,
      skills: [{ id: "vulnerabilities/idor" }],
    });
    expect(resolveSubagentSkills(["missing-skill"])).toEqual({
      success: false,
      error: expect.stringContaining("Unknown subagent skill"),
    });
  });

  it("renders a discoverable catalog and bounded specialist knowledge", () => {
    const catalog = getSubagentSkillCatalogPrompt();
    expect(catalog).toContain("<available_subagent_skills");
    expect(catalog).toContain("frameworks/nextjs:");
    expect(catalog).not.toContain("analysis/counterevidence:");

    const knowledge = renderSubagentSkillKnowledge(["vulnerabilities/idor"]);
    expect(knowledge).toContain("<specialized_knowledge>");
    expect(knowledge).toContain("## Skill: vulnerabilities/idor");
    expect(knowledge).toContain("Object-level authorization failures");
    expect(knowledge).toContain("does not grant tools");
    expect(knowledge.match(/<specialized_knowledge>/g)).toHaveLength(1);
    expect(knowledge.match(/<\/specialized_knowledge>/g)).toHaveLength(1);
  });
});
