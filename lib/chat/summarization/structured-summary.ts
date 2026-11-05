import type { ChatMode } from "@/types";

const agentSections = {
  "Target & Scope": "Target and assessment scope, including exclusions.",
  "Key Findings":
    "Confirmed findings and negative results. Preserve exact URLs, paths, parameters, payloads, versions, and errors; distinguish hypotheses from confirmed results.",
  "User Directives":
    "Explicit instructions, permissions, scope changes, and corrections, preserving the user's exact wording.",
  "Progress & Decisions":
    "Completed work, chosen approach, and the last action before interruption.",
  "Current State": "Work in progress, blockers, and active assumptions.",
  "Runtime & Execution State":
    "Exact environment, working directory, terminal/browser session and tool-call IDs, commands, PIDs, ports, output paths, progress, and how to inspect or resume unfinished work. Distinguish running, paused, completed, failed, and killed operations.",
  "Errors & Recovery":
    "Operational failures and their resolution, separate from assessment findings.",
  "Failed Attempts": "Dead ends and failed approaches to avoid repeating.",
  "Next Steps":
    "Next actions for the interrupted work, including its exact last state. Do not invent new approaches.",
  "Relevant Files & Artifacts":
    "Full paths to transcripts, scan results, logs, notes, and other artifacts, with their purpose.",
};

const askSections = {
  "Context & Goal": "The user's goal and requirements.",
  "Key Exchanges":
    "Essential exchanges, including exact URLs, code, and technical details.",
  "Decisions & Conclusions":
    "Established facts, recommendations, and choices; distinguish uncertainty.",
  "Current State": "Work in progress, blockers, and active assumptions.",
  "User Preferences & Corrections":
    "Explicit preferences, constraints, permissions, and corrections in the user's exact wording.",
  "Relevant Files & Artifacts":
    "Important paths, URLs, logs, documents, and artifacts, with their purpose.",
  "Open Threads": "Unresolved questions and unfinished tasks.",
};

const sectionsFor = (mode: ChatMode) =>
  mode === "agent" ? agentSections : askSections;

export const getCompactionSections = (mode: ChatMode) =>
  Object.keys(sectionsFor(mode));

export const getCompactionResponseFormat = (mode: ChatMode) => ({
  type: "json_schema",
  json_schema: {
    name: "context_checkpoint",
    strict: true,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(sectionsFor(mode)).map(([name, description]) => [
          name,
          { type: "string", description },
        ]),
      ),
      required: getCompactionSections(mode),
      additionalProperties: false,
    },
  },
});

export const getStructuredCompactionPrompt = (mode: ChatMode) =>
  "Compress the conversation into a checkpoint for an assistant to continue the same work. " +
  "Return only a JSON object matching the supplied schema. Each field must contain concise factual bullets, " +
  "or '(none)' only when the conversation has no relevant information for that field. " +
  "Do not continue the conversation, execute tools, or include an analysis phase. " +
  "Preserve all still-applicable goals, user instructions, scope, permissions, corrections, and unfinished work. " +
  "Merge an existing checkpoint with newer confirmed facts; silence does not cancel a requirement. " +
  "Preserve exact technical details, credentials, IDs, commands, paths, process state, and user corrections. " +
  "Keep completed and failed work needed to prevent repetition. Never mark work completed without confirming evidence. " +
  "Prioritize recent active context, consolidate repetitive output, and never invent missing facts.\n\n" +
  Object.entries(sectionsFor(mode))
    .map(([name, description]) => `${name}: ${description}`)
    .join("\n");

/** Fail closed before replacing history; never fill missing fields or use reasoning. */
export function renderStructuredCompaction(
  text: string,
  mode: ChatMode,
): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sections = getCompactionSections(mode);
  if (
    Object.keys(record).length !== sections.length ||
    sections.some(
      (name) => typeof record[name] !== "string" || !record[name].trim(),
    )
  )
    return null;
  return sections
    .map((name) => `## ${name}\n${(record[name] as string).trim()}`)
    .join("\n\n");
}
