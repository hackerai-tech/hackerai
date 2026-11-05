import type { SelectedModel } from "@/types/chat";

export interface ModelOption {
  id: SelectedModel;
  label: string;
  /** Short tagline shown in the hover popup (e.g. "Maximum intelligence for complex work") */
  description?: string;
  /** Models and reasoning shown beneath the description in the hover popup. */
  poweredBy?: string;
  thinking?: boolean;
}

export const AGENT_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "hackerai-standard",
    label: "HackerAI Standard",
    description: "Reliable agent for everyday automation",
    poweredBy: "DeepSeek V4.1 Flash 1017 · High reasoning",
    thinking: true,
  },
  {
    id: "hackerai-pro",
    label: "HackerAI Pro",
    description: "Superior performance for most assignments",
    poweredBy: "DeepSeek V4.1 Flash 1017 · Max reasoning",
    thinking: true,
  },
  {
    id: "hackerai-max",
    label: "HackerAI Max",
    description: "Maximum intelligence for complex work",
    poweredBy: "Z.ai GLM 5.3 (text), DeepSeek V4.1 Flash 1017 (vision)",
    thinking: true,
  },
];
