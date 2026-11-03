import { wait } from "@trigger.dev/sdk";
import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "@/types";
import { setActiveAgentUserWait } from "@/lib/db/agent-user-wait";
import { phLogger } from "@/lib/posthog/server";

type UserReply = {
  chatId: string;
  userId: string;
  runId: string;
  toolCallId: string;
  replyId: string;
  text: string;
};

export const createWaitForUserTool = (
  context: ToolContext,
  options: {
    beforeSuspend?: () => Promise<void>;
    pauseActiveTime?: () => void;
    resumeActiveTime?: () => void;
    revalidateAfterSuspend?: (toolCallId: string) => Promise<void>;
  } = {},
) =>
  tool({
    description:
      "Pause this interactive Agent run until the user replies in this chat. Write the question or decision you need as ordinary assistant text first, then call this tool with no arguments. Use it only when you cannot make useful progress without the user's answer. The current run resumes with that reply in the tool result. Do not use it to narrate progress, wait for delegated agents, or end a finished task. The reply may arrive after some time; never repeat the question in the tool call.",
    inputSchema: z.object({}),
    execute: async (_input, execution) => {
      const runId = context.triggerRunId;
      if (!runId) {
        return {
          success: false,
          error: "wait_for_user requires a durable interactive Agent run.",
        };
      }
      const identity = {
        chatId: context.chatId,
        userId: context.userID,
        runId,
        toolCallId: execution.toolCallId,
      };
      const token = await wait.createToken({
        idempotencyKey: `agent-user-wait:${runId}:${execution.toolCallId}`,
        // Leave time for the run's final answer and cleanup before Trigger's
        // four-hour maxDuration expires.
        timeout: "3h",
      });
      const acquired = await setActiveAgentUserWait({
        ...identity,
        tokenId: token.id,
      });
      if (acquired !== "acquired") {
        return {
          success: false,
          error:
            acquired === "busy"
              ? "Another user reply is already pending in this chat."
              : "This Agent run is no longer active in the chat.",
        };
      }

      phLogger.event("agent_wait_for_user_started", {
        userId: context.userID,
        chat_id: context.chatId,
        trigger_run_id: runId,
      });

      let activeTimePaused = false;
      try {
        await options.beforeSuspend?.();
        options.pauseActiveTime?.();
        activeTimePaused = true;
        const result = await wait.forToken<UserReply>(token);
        options.resumeActiveTime?.();
        activeTimePaused = false;
        if (!result.ok) {
          return {
            success: false,
            wait_outcome: "timed_out",
            error: "The user did not reply before this wait expired.",
          };
        }
        const reply = result.output;
        if (
          reply.chatId !== identity.chatId ||
          reply.userId !== identity.userId ||
          reply.runId !== identity.runId ||
          reply.toolCallId !== identity.toolCallId ||
          typeof reply.text !== "string" ||
          !reply.text.trim()
        ) {
          return {
            success: false,
            error: "The reply did not match this Agent wait.",
          };
        }
        await options.revalidateAfterSuspend?.(execution.toolCallId);
        phLogger.event("agent_wait_for_user_resumed", {
          userId: context.userID,
          chat_id: context.chatId,
          trigger_run_id: runId,
        });
        return {
          success: true,
          wait_outcome: "message_arrived",
          reply: reply.text,
          note: "The user replied in this chat. Continue the same task using this answer.",
        };
      } finally {
        if (activeTimePaused) options.resumeActiveTime?.();
        await setActiveAgentUserWait(identity).catch(() => {
          // The run's terminal cleanup also clears this state. Do not replace
          // a newer run's wait after a cancellation or chat deletion race.
        });
      }
    },
  });
