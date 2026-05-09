import type { ChatMode } from "@/types/chat";

/** Returns true for "agent" or "agent-long" modes. Use for shared behavior (Pro gating, tools, model selection, file handling). */
export const isAgentMode = (mode: ChatMode): boolean =>
  mode === "agent" || mode === "agent-long";

/** Returns true only for the durable "agent-long" mode that runs on trigger.dev. */
export const isAgentLongMode = (mode: ChatMode): boolean =>
  mode === "agent-long";
