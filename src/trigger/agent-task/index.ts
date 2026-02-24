"use node";

import { task } from "@trigger.dev/sdk/v3";
import { clearActiveTriggerRunIdFromBackend } from "@/lib/db/actions";
import { extractErrorDetails } from "@/lib/utils/error-utils";
import { triggerAxiomLogger } from "@/lib/axiom/trigger";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
import { createAgentStreamContext } from "./context";
import { runAgentStream } from "./run-agent-stream";

export const agentStreamTask = task({
  id: "agent-stream",
  retry: { maxAttempts: 0 },
  run: async (payload: AgentTaskPayload) => {
    const context = createAgentStreamContext(payload);
    try {
      await runAgentStream(context, payload);
    } catch (error) {
      context.chatLogger.emitUnexpectedError(error);
      triggerAxiomLogger.error("Unexpected error in agent-task", {
        chatId: payload.chatId,
        mode: payload.mode,
        userId: payload.userId,
        subscription: payload.subscription,
        isTemporary: payload.temporary,
        ...extractErrorDetails(error),
      });
      await triggerAxiomLogger.flush();
      throw error;
    }
  },
});
