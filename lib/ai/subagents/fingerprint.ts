import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type {
  SecurityValidationCandidate,
  SubagentContextRef,
  SubagentProfile,
} from "./contracts";

const normalize = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

const normalizeContextRef = (ref: SubagentContextRef): string => {
  switch (ref.kind) {
    case "message_part":
      return `message:${ref.message_id}:${ref.part_index}`;
    case "tool_call":
      return `tool:${ref.message_id}:${ref.tool_call_id}`;
    case "sandbox_file":
      return `file:${ref.path}:${ref.start_line ?? ""}:${ref.end_line ?? ""}`;
    case "note":
      return `note:${ref.note_id}`;
  }
};

export const createCandidateFingerprint = (
  candidate: SecurityValidationCandidate,
  contextRefs: SubagentContextRef[],
): string => {
  const canonical = JSON.stringify({
    title: normalize(candidate.title),
    affectedAsset: normalize(candidate.affected_asset),
    weaknessClass: normalize(candidate.weakness_class),
    contextRefs: contextRefs.map(normalizeContextRef).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
};

export const createAgentFingerprint = ({
  profile,
  name,
  task,
  successCriteria,
  skills,
}: {
  profile: SubagentProfile;
  name: string;
  task: string;
  successCriteria: string[];
  skills: string[];
}): string => {
  const canonical = JSON.stringify({
    profile,
    name: normalize(name),
    task: normalize(task),
    successCriteria: successCriteria.map(normalize),
    skills: skills.map(normalize).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
};

export const createSubagentId = (): string =>
  `sa_${randomUUID().replaceAll("-", "")}`;

export const createSubagentUpdateMessageId = (
  parentTriggerRunId: string,
  targetAgentId: string,
  parentToolCallId: string,
): string =>
  `msg_${createHash("sha256")
    .update(
      JSON.stringify({
        parentTriggerRunId,
        targetAgentId,
        parentToolCallId,
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
