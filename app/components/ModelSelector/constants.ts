import type { ChatMode, SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";

export interface ModelOption {
  id: SelectedModel;
  label: string;
  thinking?: boolean;
  censored?: boolean;
  /** Desktop-only model using user's own account */
  localProvider?: boolean;
}

export const ASK_MODEL_OPTIONS: ModelOption[] = [
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "grok-4.1", label: "Grok 4.1" },
  { id: "sonnet-4.6", label: "Claude Sonnet 4.6", censored: true },
  { id: "opus-4.6", label: "Claude Opus 4.6", censored: true },
];

export const AGENT_MODEL_OPTIONS: ModelOption[] = [
  { id: "kimi-k2.5", label: "Kimi K2.5", thinking: true },
  { id: "grok-4.1", label: "Grok 4.1", thinking: true },
  { id: "sonnet-4.6", label: "Claude Sonnet 4.6", censored: true },
  { id: "opus-4.6", label: "Claude Opus 4.6", censored: true },
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
