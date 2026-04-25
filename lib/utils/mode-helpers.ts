import type { ChatMode } from "@/types/chat";

/** Returns true for "agent" or "agent-long" mode. Use for shared behavior (Pro gating, tools, model selection, file handling). */
export const isAgentMode = (mode: ChatMode): boolean =>
  mode === "agent" || mode === "agent-long";

/** Returns true only for the long-running workflow-backed agent mode. */
export const isAgentLongMode = (mode: ChatMode): boolean =>
  mode === "agent-long";

/**
 * Map a `ChatMode` to the narrow `"ask" | "agent"` type used by legacy
 * server/storage helpers that pre-date the `agent-long` workflow mode.
 * `agent-long` collapses to `"agent"` since it shares all tooling, system
 * prompts, and gating with the standard agent mode — only the transport
 * differs (Workflow SDK vs. inline streamText).
 */
export const toLegacyChatMode = (
  mode: ChatMode | undefined,
): "ask" | "agent" | undefined => {
  if (mode === undefined) return undefined;
  return mode === "agent-long" ? "agent" : mode;
};
