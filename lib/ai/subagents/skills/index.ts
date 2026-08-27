import strixRegistry from "./strix-skill-catalog.generated.json";

import { MAX_SUBAGENT_SKILLS } from "../contracts";
import { getSubagentSkillSafetyOverride } from "./safety-overrides";

const MAX_SELECTED_SKILL_BYTES = 96 * 1024;

export type SubagentSkill = {
  id: string;
  category: string;
  filename: string;
  name: string;
  description: string;
  contentBytes: number;
  sourcePath: string;
  sourceSha256: string;
};

type GeneratedSkill = SubagentSkill & { internal: boolean };

const selectableSkills = (strixRegistry.skills as GeneratedSkill[])
  .filter((skill) => !skill.internal)
  .sort((left, right) => left.id.localeCompare(right.id));
const skillsById = new Map(selectableSkills.map((skill) => [skill.id, skill]));
const aliases = new Map<string, SubagentSkill[]>();

for (const skill of selectableSkills) {
  const values = new Set([skill.filename, skill.name]);
  for (const value of values) {
    aliases.set(value, [...(aliases.get(value) ?? []), skill]);
  }
}

export const STRIX_SUBAGENT_SKILL_SOURCE_COMMIT = strixRegistry.sourceCommit;
export const STRIX_SUBAGENT_SKILL_COUNT = selectableSkills.length;

export const listSubagentSkills = (): readonly SubagentSkill[] =>
  selectableSkills;

export type ResolveSubagentSkillsResult =
  | { success: true; skills: SubagentSkill[] }
  | { success: false; error: string };

export const resolveSubagentSkills = (
  requested: readonly string[],
): ResolveSubagentSkillsResult => {
  if (requested.length > MAX_SUBAGENT_SKILLS) {
    return {
      success: false,
      error: `Choose at most ${MAX_SUBAGENT_SKILLS} subagent skills; prefer 1-3 closely related skills.`,
    };
  }

  const resolved: SubagentSkill[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const ambiguous: string[] = [];

  for (const raw of requested) {
    const value = raw.trim();
    const exact = skillsById.get(value);
    const matches = exact ? [exact] : (aliases.get(value) ?? []);
    if (matches.length === 0) {
      invalid.push(value);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(value);
      continue;
    }
    const skill = matches[0];
    if (seen.has(skill.id)) {
      return {
        success: false,
        error: `Duplicate subagent skill: ${skill.id}`,
      };
    }
    seen.add(skill.id);
    resolved.push(skill);
  }

  if (invalid.length > 0) {
    return {
      success: false,
      error: `Unknown subagent skill(s): ${invalid.join(", ")}. Use exact ids from <available_subagent_skills>.`,
    };
  }
  if (ambiguous.length > 0) {
    return {
      success: false,
      error: `Ambiguous subagent skill(s): ${ambiguous.join(", ")}. Use category-qualified ids.`,
    };
  }

  const totalBytes = resolved.reduce(
    (total, skill) => total + skill.contentBytes,
    0,
  );
  if (totalBytes > MAX_SELECTED_SKILL_BYTES) {
    return {
      success: false,
      error:
        "The selected subagent skills are too large together. Choose fewer, more focused skills.",
    };
  }

  return { success: true, skills: resolved };
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const getSubagentSkillCatalogPrompt = (): string => {
  const grouped = new Map<string, SubagentSkill[]>();
  for (const skill of selectableSkills) {
    grouped.set(skill.category, [
      ...(grouped.get(skill.category) ?? []),
      skill,
    ]);
  }
  const catalog = [...grouped.entries()]
    .map(
      ([category, skills]) =>
        `[${category}]\n${skills
          .map(
            (skill) =>
              `- ${skill.id}: ${escapeXml(
                (
                  getSubagentSkillSafetyOverride(skill.id)
                    ?.catalogDescription ?? skill.description
                )
                  .replaceAll(/\s+/g, " ")
                  .trim(),
              )}`,
          )
          .join("\n")}`,
    )
    .join("\n\n");

  return `<available_subagent_skills source="usestrix/strix" commit="${STRIX_SUBAGENT_SKILL_SOURCE_COMMIT}">
Choose 1-3 closely related skills for a specialist security_task. Use exact category-qualified ids. A skill supplies methodology only; it does not grant tools, permissions, authorization, or broader scope. Use no skill only when none applies. Maximum ${MAX_SUBAGENT_SKILLS}.

${catalog}
</available_subagent_skills>`;
};
