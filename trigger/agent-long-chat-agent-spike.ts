import { chat } from "@trigger.dev/sdk/ai";
import { stepCountIs, streamText } from "ai";

import { createTrackedProvider } from "@/lib/ai/providers";
import {
  isTriggerChatAgentSpikeEnabled,
  TRIGGER_CHAT_AGENT_SPIKE_ENV,
} from "@/lib/chat/trigger-chat-agent-spike";

const PROTOTYPE_SYSTEM_PROMPT = [
  "You are running a HackerAI Trigger chat.agent migration prototype.",
  "Answer basic text chat only.",
  "Do not claim access to HackerAI sandbox tools, files, billing state, todos, or model fallback behavior.",
].join(" ");

// Prototype only: no live HackerAI route points at this task. It exists so we
// can validate Trigger.dev's native chat/session transport separately from the
// current agent-long billing, sandbox, file, todo, and persistence stack.
export const agentLongChatAgentSpike = chat.agent({
  id: "agent-long-chat-agent-spike",
  run: async ({ messages, signal }) => {
    if (!isTriggerChatAgentSpikeEnabled()) {
      throw new Error(
        `agent-long-chat-agent-spike is disabled. Set ${TRIGGER_CHAT_AGENT_SPIKE_ENV}=1 to run the prototype.`,
      );
    }

    const provider = createTrackedProvider();
    chat.prompt.set(PROTOTYPE_SYSTEM_PROMPT);

    return streamText({
      ...chat.toStreamTextOptions(),
      model: provider.languageModel("agent-model"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});
