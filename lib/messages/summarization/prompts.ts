import type { ChatMode } from "@/types";

export const AGENT_SUMMARIZATION_PROMPT =
  "You are an agent performing context condensation for a security agent. Your job is to compress scan data while preserving ALL operationally critical information for continuing the security assessment.\n\n" +
  "CRITICAL ELEMENTS TO PRESERVE:\n" +
  "- Discovered vulnerabilities and potential attack vectors\n" +
  "- Scan results and tool outputs (compressed but maintaining key findings)\n" +
  "- Access credentials, tokens, or authentication details found\n" +
  "- System architecture insights and potential weak points\n" +
  "- Progress made in the assessment\n" +
  "- Failed attempts and dead ends (to avoid duplication)\n" +
  "- Any decisions made about the testing approach\n\n" +
  "COMPRESSION GUIDELINES:\n" +
  "- Preserve exact technical details (URLs, paths, parameters, payloads)\n" +
  "- Summarize verbose tool outputs while keeping critical findings\n" +
  "- Maintain version numbers, specific technologies identified\n" +
  "- Keep exact error messages that might indicate vulnerabilities\n" +
  "- Compress repetitive or similar findings into consolidated form\n\n" +
  "Remember: Another security agent will use this summary to continue the assessment. They must be able to pick up exactly where you left off without losing any operational advantage or context needed to find vulnerabilities.";

export const ASK_SUMMARIZATION_PROMPT =
  "You are performing context condensation for a conversational assistant. Your job is to compress the conversation while preserving key information for continuity.\n\n" +
  "CRITICAL ELEMENTS TO PRESERVE:\n" +
  "- User's questions and the assistant's answers\n" +
  "- Key facts, decisions, and conclusions reached\n" +
  "- Any URLs, code snippets, or technical details shared\n" +
  "- User preferences or context mentioned\n" +
  "- Unresolved questions or ongoing threads\n\n" +
  "COMPRESSION GUIDELINES:\n" +
  "- Preserve exact technical details when relevant\n" +
  "- Summarize repetitive exchanges into consolidated form\n" +
  "- Maintain the conversational flow and context\n" +
  "- Keep user-stated goals and requirements\n\n" +
  "Remember: The assistant will use this summary to continue helping the user seamlessly.";

export const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;
