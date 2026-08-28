import { describe, expect, it } from "@jest/globals";
import { existsSync } from "node:fs";
import { join } from "node:path";
import upstreamManifest from "@/third_party/strix-skills/UPSTREAM.json";

import {
  STRIX_SUBAGENT_SKILL_COUNT,
  STRIX_SUBAGENT_SKILL_SOURCE_COMMIT,
  listSubagentSkills,
  resolveSubagentSkills,
} from "../skills";
import { renderSubagentSkillKnowledge } from "../skills/knowledge";
import { listSubagentSkillSafetyOverrideIds } from "../skills/safety-overrides";

describe("Strix subagent skills", () => {
  it("exposes methodology skills without internal orchestration or tooling skills", () => {
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
    expect(
      listSubagentSkills().some((skill) => skill.id === "scan_modes/deep"),
    ).toBe(false);
    expect(
      listSubagentSkills().some(
        (skill) => skill.id === "coordination/root_agent",
      ),
    ).toBe(false);
    expect(
      listSubagentSkills().some((skill) => skill.category === "tooling"),
    ).toBe(false);
    expect(
      Object.keys(upstreamManifest.files).some((path) =>
        path.startsWith("tooling/"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(process.cwd(), "third_party", "strix-skills", "skills", "tooling"),
      ),
    ).toBe(false);
  });

  it("resolves qualified ids and unambiguous Strix aliases", () => {
    expect(resolveSubagentSkills([])).toEqual({ success: true, skills: [] });
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
    expect(resolveSubagentSkills(["tooling/nmap"])).toEqual({
      success: false,
      error: expect.stringContaining("Unknown subagent skill"),
    });
  });

  it("canonicalizes skill sets for stable persisted ids and prompt prefixes", () => {
    const forward = resolveSubagentSkills([
      "cloud/aws",
      "vulnerabilities/idor",
    ]);
    const reverse = resolveSubagentSkills([
      "vulnerabilities/idor",
      "cloud/aws",
    ]);

    expect(forward).toMatchObject({
      success: true,
      skills: [{ id: "cloud/aws" }, { id: "vulnerabilities/idor" }],
    });
    expect(reverse).toEqual(forward);
    expect(
      renderSubagentSkillKnowledge(["vulnerabilities/idor", "cloud/aws"]),
    ).toBe(renderSubagentSkillKnowledge(["cloud/aws", "vulnerabilities/idor"]));
  });

  it("renders bounded specialist knowledge only when explicitly requested", () => {
    expect(renderSubagentSkillKnowledge([])).toBe(
      "No specialist skills were assigned.",
    );
    const knowledge = renderSubagentSkillKnowledge(["vulnerabilities/idor"]);
    expect(knowledge).toContain("<specialized_knowledge>");
    expect(knowledge).toContain("## Skill: vulnerabilities/idor");
    expect(knowledge).toContain("Object-level authorization failures");
    expect(knowledge).toContain("does not grant tools");
    expect(knowledge.match(/<specialized_knowledge>/g)).toHaveLength(1);
    expect(knowledge.match(/<\/specialized_knowledge>/g)).toHaveLength(1);
  });

  it("applies local safety corrections without modifying vendored files", () => {
    for (const skillId of listSubagentSkillSafetyOverrideIds()) {
      expect(resolveSubagentSkills([skillId])).toMatchObject({ success: true });
    }

    const aws = renderSubagentSkillKnowledge(["cloud/aws"]);
    expect(aws).toContain("HackerAI runtime override (takes precedence)");
    expect(aws).toContain("Never pass access keys");

    const dependency = renderSubagentSkillKnowledge([
      "custom/dependency_cve_scanning",
    ]);
    expect(dependency).toContain(
      "create_dependency_report and create_vulnerability_report tools are unavailable",
    );

    const nosql = renderSubagentSkillKnowledge([
      "vulnerabilities/nosql_injection",
    ]);
    expect(nosql).toContain("Never use unbounded loops");

    expect(
      listSubagentSkills().find(
        (skill) => skill.id === "custom/dependency_cve_scanning",
      )?.description,
    ).toContain("Supply-chain/SCA playbook for returning lockfile");
  });
});
