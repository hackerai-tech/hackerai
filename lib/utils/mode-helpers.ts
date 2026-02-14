import type { ChatMode } from "@/types/chat";

/** Returns true for both "agent" and "agent-long" modes. Use for shared behavior (Pro gating, tools, model selection, file handling). Do NOT use for routing decisions. */
export const isAgentMode = (mode: ChatMode): boolean =>
  mode === "agent" || mode === "agent-long";
