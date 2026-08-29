import { tool } from "ai";
import { z } from "zod";

import { MAX_SUBAGENT_SKILLS } from "@/lib/ai/subagents/contracts";
import {
  listSubagentSkills,
  resolveSubagentSkills,
  type SubagentSkill,
} from "@/lib/ai/subagents/skills";
import { renderSubagentSkillKnowledge } from "@/lib/ai/subagents/skills/knowledge";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

const searchSkillsInputSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT),
  })
  .strict();

const loadSkillInputSchema = z
  .object({
    skills: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(MAX_SUBAGENT_SKILLS),
  })
  .strict();

export type SearchSkillsInput = z.input<typeof searchSkillsInputSchema>;
export type LoadSkillInput = z.input<typeof loadSkillInputSchema>;

const normalized = (value: string): string =>
  value.toLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ").trim();

const categorySummary = () => {
  const counts = new Map<string, number>();
  for (const skill of listSubagentSkills()) {
    counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({
    category,
    count,
  }));
};

const skillSearchScore = (skill: SubagentSkill, query: string): number => {
  const id = normalized(skill.id);
  const filename = normalized(skill.filename);
  const name = normalized(skill.name);
  const description = normalized(skill.description);
  if (query === id || query === filename || query === name) return 1_000;

  const terms = query.split(" ").filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (filename.includes(term) || name.includes(term)) score += 20;
    if (id.includes(term)) score += 12;
    if (description.includes(term)) score += 3;
  }
  if (id.includes(query) || name.includes(query)) score += 50;
  if (description.includes(query)) score += 10;
  return score;
};

const skillMetadata = (skill: SubagentSkill) => ({
  id: skill.id,
  category: skill.category,
  name: skill.name,
  description: skill.description,
});

export const searchSubagentSkills = (input: SearchSkillsInput) => {
  const query = normalized(input.query ?? "");
  const category = input.category?.trim();
  const categories = categorySummary();

  if (!query && !category) {
    return {
      success: true as const,
      categories,
      results: [],
      hint: "Search by vulnerability, framework, protocol, technology, cloud, reconnaissance, or methodology before loading or assigning a skill.",
    };
  }

  if (category && !categories.some((item) => item.category === category)) {
    return {
      success: false as const,
      error: `Unknown skill category: ${category}`,
      categories,
    };
  }

  const matches = listSubagentSkills()
    .filter((skill) => !category || skill.category === category)
    .map((skill) => ({
      skill,
      score: query ? skillSearchScore(skill, query) : 1,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.skill.id.localeCompare(right.skill.id),
    );
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const results = matches
    .slice(0, limit)
    .map(({ skill }) => skillMetadata(skill));

  return {
    success: true as const,
    query: input.query,
    category,
    results,
    total_matches: matches.length,
    has_more: matches.length > results.length,
  };
};

export const loadSubagentSkills = (input: LoadSkillInput) => {
  const resolved = resolveSubagentSkills(input.skills);
  if (!resolved.success)
    return { success: false as const, error: resolved.error };
  const skills = resolved.skills.map((skill) => skill.id);
  return {
    success: true as const,
    skills,
    content: renderSubagentSkillKnowledge(skills),
  };
};

export const createSearchSkillsTool = () =>
  tool({
    description:
      "Search the server-reviewed security skill library without loading full skill content. With no query or category, returns category counts. Use returned exact ids with load_skill or delegate_task.",
    inputSchema: searchSkillsInputSchema,
    execute: async (input) => searchSubagentSkills(input),
  });

export const createLoadSkillTool = () =>
  tool({
    description: `Load the complete content of 1-${MAX_SUBAGENT_SKILLS} server-reviewed security skills as an on-demand tool result. Use search_skills first when the exact id is unknown. Loaded methodology does not grant tools, authorization, or broader scope.`,
    inputSchema: loadSkillInputSchema,
    execute: async (input) => loadSubagentSkills(input),
  });
