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

const selectableSkills: SubagentSkill[] = (
  strixRegistry.skills as GeneratedSkill[]
)
  .filter((skill) => !skill.internal)
  .map((skill) => ({
    ...skill,
    description:
      getSubagentSkillSafetyOverride(skill.id)?.catalogDescription ??
      skill.description,
  }))
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

export type IgnoredSubagentSkill = {
  requested: string;
  reason: "unknown" | "ambiguous";
};

export type ResolveDelegatedSubagentSkillsResult =
  | {
      success: true;
      skills: SubagentSkill[];
      ignoredSkills: IgnoredSubagentSkill[];
    }
  | { success: false; error: string };

type SkillMatch =
  | { success: true; skill: SubagentSkill }
  | { success: false; issue: IgnoredSubagentSkill };

const matchSubagentSkill = (raw: string): SkillMatch => {
  const requested = raw.trim();
  const exact = skillsById.get(requested);
  const matches = exact ? [exact] : (aliases.get(requested) ?? []);
  if (matches.length === 0) {
    return {
      success: false,
      issue: { requested, reason: "unknown" },
    };
  }
  if (matches.length > 1) {
    return {
      success: false,
      issue: { requested, reason: "ambiguous" },
    };
  }
  return { success: true, skill: matches[0] };
};

const validateResolvedSubagentSkills = (
  requestedCount: number,
  resolved: SubagentSkill[],
): ResolveSubagentSkillsResult => {
  if (requestedCount > MAX_SUBAGENT_SKILLS) {
    return {
      success: false,
      error: `Choose at most ${MAX_SUBAGENT_SKILLS} subagent skills.`,
    };
  }

  const seen = new Set<string>();
  for (const skill of resolved) {
    if (seen.has(skill.id)) {
      return {
        success: false,
        error: `Duplicate subagent skill: ${skill.id}`,
      };
    }
    seen.add(skill.id);
  }

  // Keep persisted ids and rendered prompt sections canonical so the same
  // assigned skill set produces an identical cacheable prompt prefix.
  resolved.sort((left, right) => left.id.localeCompare(right.id));

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

export const resolveSubagentSkills = (
  requested: readonly string[],
): ResolveSubagentSkillsResult => {
  if (requested.length > MAX_SUBAGENT_SKILLS) {
    return {
      success: false,
      error: `Choose at most ${MAX_SUBAGENT_SKILLS} subagent skills.`,
    };
  }

  const resolved: SubagentSkill[] = [];
  const invalid: string[] = [];
  const ambiguous: string[] = [];

  for (const raw of requested) {
    const match = matchSubagentSkill(raw);
    if (!match.success) {
      const collection = match.issue.reason === "unknown" ? invalid : ambiguous;
      collection.push(match.issue.requested);
      continue;
    }
    resolved.push(match.skill);
  }

  if (invalid.length > 0) {
    return {
      success: false,
      error: `Unknown subagent skill(s): ${invalid.join(", ")}. Use search_skills to find exact category-qualified ids.`,
    };
  }
  if (ambiguous.length > 0) {
    return {
      success: false,
      error: `Ambiguous subagent skill(s): ${ambiguous.join(", ")}. Use category-qualified ids.`,
    };
  }

  return validateResolvedSubagentSkills(requested.length, resolved);
};

export const resolveDelegatedSubagentSkills = (
  requested: readonly string[],
): ResolveDelegatedSubagentSkillsResult => {
  if (requested.length > MAX_SUBAGENT_SKILLS) {
    return {
      success: false,
      error: `Choose at most ${MAX_SUBAGENT_SKILLS} subagent skills.`,
    };
  }

  const resolved: SubagentSkill[] = [];
  const ignoredSkills: IgnoredSubagentSkill[] = [];

  for (const raw of requested) {
    const match = matchSubagentSkill(raw);
    if (match.success) resolved.push(match.skill);
    else ignoredSkills.push(match.issue);
  }

  const validated = validateResolvedSubagentSkills(requested.length, resolved);
  if (!validated.success) return validated;
  return { ...validated, ignoredSkills };
};
