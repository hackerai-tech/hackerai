import { ChatMode } from "@/types";
import {
  AGENT_SUMMARIZATION_PROMPT,
  ASK_SUMMARIZATION_PROMPT,
} from "./prompts";

export const getSummarizationPrompt = (mode: ChatMode): string =>
  mode === "agent" ? AGENT_SUMMARIZATION_PROMPT : ASK_SUMMARIZATION_PROMPT;
