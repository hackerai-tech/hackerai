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
  /** Desktop-only model using user's own account */
  localProvider?: boolean;
}

export const ASK_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gemini-3-flash",
    label: "HackerAI Lite",
    description: "Fast and efficient for everyday tasks",
    poweredBy: "Google Gemini 3 Flash",
  },
  {
    id: "sonnet-4.6",
    label: "HackerAI Pro",
    description: "Superior performance for most assignments",
    poweredBy: "Claude Sonnet 4.6",
  },
  {
    id: "opus-4.6",
    label: "HackerAI Max",
    description: "Maximum intelligence for complex work",
    poweredBy: "Claude Opus 4.6",
  },
];

export const AGENT_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "kimi-k2.6",
    label: "HackerAI Lite",
    description: "Fast agent for everyday automation",
    poweredBy: "Moonshot Kimi K2.6",
    thinking: true,
  },
  {
    id: "sonnet-4.6",
    label: "HackerAI Pro",
    description: "Superior performance for most assignments",
    poweredBy: "Claude Sonnet 4.6",
    thinking: true,
  },
  {
    id: "opus-4.6",
    label: "HackerAI Max",
    description: "Maximum intelligence for complex work",
    poweredBy: "Claude Opus 4.6",
    thinking: true,
  },
];

// export const CODEX_LOCAL_OPTIONS: ModelOption[] = [
//   { id: "codex-local:gpt-5.4", label: "GPT-5.4", localProvider: true },
//   {
//     id: "codex-local:gpt-5.4-mini",
//     label: "GPT-5.4 Mini",
//     localProvider: true,
//   },
//   {
//     id: "codex-local:gpt-5.3-codex",
//     label: "GPT-5.3 Codex",
//     localProvider: true,
//   },
//   {
//     id: "codex-local:gpt-5.2-codex",
//     label: "GPT-5.2 Codex",
//     localProvider: true,
//   },
//   { id: "codex-local:gpt-5.2", label: "GPT-5.2", localProvider: true },
// ];
export const CODEX_LOCAL_OPTIONS: ModelOption[] = [];

export const getDefaultModelForMode = (mode: ChatMode): SelectedModel => {
  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;
  return options[0].id;
};
