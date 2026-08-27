import { describe, expect, it } from "@jest/globals";

import {
  loadSubagentSkills,
  searchSubagentSkills,
} from "../subagent-skill-tools";

describe("on-demand subagent skill tools", () => {
  it("lists compact categories without loading content", () => {
    const result = searchSubagentSkills({ limit: 8 });

    expect(result).toMatchObject({ success: true, results: [] });
    if (!result.success) throw new Error(result.error);
    expect(result.categories).toContainEqual({
      category: "vulnerabilities",
      count: expect.any(Number),
    });
    expect(result.categories.some((item) => item.category === "tooling")).toBe(
      false,
    );
    expect(JSON.stringify(result)).not.toContain("<specialized_knowledge>");
  });

  it("finds exact ids from metadata without returning full skill bodies", () => {
    const result = searchSubagentSkills({ query: "IDOR", limit: 5 });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.results[0]?.id).toBe("vulnerabilities/idor");
    expect(JSON.stringify(result)).not.toContain("Testing Methodology");
  });

  it("loads full content only for explicitly requested validated ids", () => {
    const result = loadSubagentSkills({ skills: ["vulnerabilities/idor"] });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.skills).toEqual(["vulnerabilities/idor"]);
    expect(result.content).toContain("<specialized_knowledge>");
    expect(result.content).toContain("## Skill: vulnerabilities/idor");
    expect(result.content).toContain("Object-level authorization failures");
  });

  it("rejects unknown, duplicate, and excessive dynamic loads", () => {
    expect(loadSubagentSkills({ skills: ["tooling/nmap"] })).toMatchObject({
      success: false,
      error: expect.stringContaining("Unknown subagent skill"),
    });
    expect(
      loadSubagentSkills({
        skills: ["vulnerabilities/idor", "vulnerabilities/idor"],
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("Duplicate subagent skill"),
    });
    expect(
      loadSubagentSkills({
        skills: [
          "vulnerabilities/idor",
          "vulnerabilities/xss",
          "vulnerabilities/ssrf",
          "vulnerabilities/csrf",
          "vulnerabilities/xxe",
          "vulnerabilities/sql_injection",
        ],
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("Choose at most 5"),
    });
  });
});
