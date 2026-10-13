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

it.each([
  [
    "protocols/oauth",
    "Missing state alone does not establish OAuth login CSRF",
  ],
  [
    "technologies/supabase",
    "A browser 401 does not establish that a leaked secret key is revoked",
  ],
  [
    "vulnerabilities/insecure_deserialization",
    "PHP 8 no longer automatically unserializes Phar metadata",
  ],
  [
    "vulnerabilities/weak_password_detection",
    "missing character-class rules or password history alone is not a vulnerability",
  ],
])(
  "loads the effective correction after the reference guidance for %s",
  (skill, correction) => {
    const result = loadSubagentSkills({ skills: [skill] });
    if (!result.success) throw new Error(result.error);
    const overrideIndex = result.content.indexOf(
      "HackerAI runtime override (takes precedence)",
    );
    expect(overrideIndex).toBeGreaterThan(0);
    expect(result.content.indexOf(correction)).toBeGreaterThan(overrideIndex);
    expect(result.content).toContain(
      "does not grant tools, permissions, authorization, or additional scope",
    );
  },
);
