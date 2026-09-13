import { memo } from "react";
import { BookOpenCheck, Search } from "lucide-react";

import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus } from "@/types/chat";
import { formatSubagentSkillLabel } from "../SubagentSkillBadges";

type SubagentSkillToolName = "search_skills" | "load_skill";

const skillIdsFromPart = (part: any): string[] => {
  const outputSkills = part.output?.skills;
  if (Array.isArray(outputSkills)) {
    return outputSkills.filter(
      (skill: unknown): skill is string => typeof skill === "string",
    );
  }

  const inputSkills = part.input?.skills;
  return Array.isArray(inputSkills)
    ? inputSkills.filter(
        (skill: unknown): skill is string => typeof skill === "string",
      )
    : [];
};

const skillTarget = (part: any): string | undefined => {
  const labels = skillIdsFromPart(part).map(formatSubagentSkillLabel);
  return labels.length > 0 ? labels.join(", ") : undefined;
};

const searchTarget = (part: any): string | undefined => {
  if (typeof part.input?.query === "string" && part.input.query.trim()) {
    return part.input.query.trim();
  }
  if (typeof part.input?.category === "string" && part.input.category.trim()) {
    return part.input.category.trim();
  }
  if (Array.isArray(part.output?.results)) {
    return `${part.output.results.length} results`;
  }
  return undefined;
};

export const SubagentSkillToolHandler = memo(function SubagentSkillToolHandler({
  part,
  status,
  toolName,
}: {
  part: any;
  status: ChatStatus;
  toolName: SubagentSkillToolName;
}) {
  const { errorText, output, state, toolCallId } = part;
  const isSearch = toolName === "search_skills";
  const isWaiting =
    status === "streaming" &&
    (state === "input-streaming" || state === "input-available");
  const target = isSearch ? searchTarget(part) : skillTarget(part);
  const Icon = isSearch ? Search : BookOpenCheck;

  if (isWaiting) {
    return (
      <ToolBlock
        key={toolCallId}
        icon={<Icon aria-hidden />}
        action={isSearch ? "Searching skills" : "Loading skills"}
        target={target}
        isShimmer
      />
    );
  }

  if (state === "output-available") {
    if (output?.success === false) {
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Icon aria-hidden />}
          action={isSearch ? "Skill search failed" : "Skill load failed"}
          target={output.error}
        />
      );
    }

    const skillCount = skillIdsFromPart(part).length;
    return (
      <ToolBlock
        key={toolCallId}
        icon={<Icon aria-hidden />}
        action={
          isSearch
            ? "Searched skills"
            : skillCount === 1
              ? "Loaded skill"
              : `Loaded ${skillCount} skills`
        }
        target={target}
      />
    );
  }

  if (state === "output-error") {
    return (
      <ToolBlock
        key={toolCallId}
        icon={<Icon aria-hidden />}
        action={isSearch ? "Skill search failed" : "Skill load failed"}
        target={errorText}
      />
    );
  }

  return null;
});
