import type { ChatMode } from "@/types/chat";

/** Returns true for "agent" mode. Use for shared behavior (Pro gating, tools, model selection, file handling). */
export const isAgentMode = (mode: ChatMode): boolean => mode === "agent";
