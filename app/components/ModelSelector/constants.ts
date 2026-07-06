import type { ChatMode, SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

export interface ModelOption {
  id: SelectedModel;
  label: string;
  /** Short tagline shown in the hover popup (e.g. "Maximum intelligence for complex work") */
  description?: string;
  /** "Powered by …" line shown beneath the description in the hover popup */
  poweredBy?: string;
  thinking?: boolean;
}

export const ASK_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "hackerai-standard",
    label: "HackerAI Standard",
    description: "Reliable performance for everyday tasks",
    poweredBy: "DeepSeek V4 Pro · Grok 4.3 for images and PDFs",
  },
  {
    id: "hackerai-pro",
    label: "HackerAI Pro",
    description: "Superior performance for most assignments",
    poweredBy: "Z.ai GLM 5.2 · Kimi K2.7 for vision",
  },
  {
    id: "hackerai-max",
    label: "HackerAI Max",
    description: "Maximum intelligence for complex work",
    poweredBy: "Claude Opus 4.6",
  },
];

export const AGENT_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "hackerai-standard",
    label: "HackerAI Standard",
    description: "Reliable agent for everyday automation",
    poweredBy: "MiniMax M3",
    thinking: true,
  },
  {
    id: "hackerai-pro",
    label: "HackerAI Pro",
    description: "Superior performance for most assignments",
    poweredBy: "Z.ai GLM 5.2 · Kimi K2.7 for vision",
    thinking: true,
  },
  {
    id: "hackerai-max",
    label: "HackerAI Max",
    description: "Maximum intelligence for complex work",
    poweredBy: "Claude Opus 4.6",
    thinking: true,
  },
];

export const getDefaultModelForMode = (mode: ChatMode): SelectedModel => {
  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;
  return options[0].id;
};
