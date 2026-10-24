import type { ChatMessage } from "@/types";
import { stripAgentLongHeartbeatParts } from "./agent-long-heartbeat";
import { hasVisibleAssistantContent } from "./abort-persistence";

type AgentLongPartialSaveMessage = {
  id: string;
  role: "assistant";
  parts: ChatMessage["parts"];
  generationStartedAt?: number;
  generationTimeMs?: number;
};

export const getLatestAgentLongAssistantMessageForPartialSave = (
  messages: ChatMessage[],
  runId: string,
): AgentLongPartialSaveMessage | undefined => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") return undefined;
  // Agent runs use their run ID as the stable assistant message ID. A new
  // run correlation can arrive while the UI still holds the previous response.
  if (message.id !== runId) return undefined;

  const stripped = stripAgentLongHeartbeatParts(message);
  if (!stripped.parts || stripped.parts.length === 0) return undefined;
  if (!hasVisibleAssistantContent([stripped])) return undefined;

  const metadata = (
    stripped as ChatMessage & {
      metadata?: {
        generationStartedAt?: unknown;
        generationTimeMs?: unknown;
      };
    }
  ).metadata;

  return {
    id: stripped.id,
    role: "assistant",
    parts: stripped.parts,
    generationStartedAt:
      typeof metadata?.generationStartedAt === "number"
        ? metadata.generationStartedAt
        : undefined,
    generationTimeMs:
      typeof metadata?.generationTimeMs === "number"
        ? metadata.generationTimeMs
        : undefined,
  };
};
