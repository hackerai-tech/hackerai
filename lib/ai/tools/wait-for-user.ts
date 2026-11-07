import { wait } from "@trigger.dev/sdk";
import { tool } from "ai";
import { z } from "zod";

import { userInputQuestionsSchema } from "@/lib/chat/user-input-questions";

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
    abortRun?: () => void;
    revalidateAfterSuspend?: (toolCallId: string) => Promise<void>;
  } = {},
) =>
  tool({
    description:
      "Pause this interactive Agent run until the user replies in this chat. Provide questions to show an interactive question panel. Give each question a stable unique id, short header, question text, and options with unique values and concise labels/descriptions. Use multiSelect for multiple choices; custom answers are allowed unless allowCustomAnswer is false. Use an empty options array for free-text questions. For a simple prose-only question, write it as assistant text and omit questions. Use it only when you cannot make useful progress without the user's answer. The current run resumes with that reply in the tool result. Do not use it to narrate progress, wait for delegated agents, or end a finished task. The reply may arrive after some time; Do not repeat a structured question in ordinary assistant text.",
    inputSchema: z.object({ questions: userInputQuestionsSchema.optional() }),
    execute: async (input, execution) => {
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
        ...(input.questions ? { questions: input.questions } : {}),
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
          options.abortRun?.();
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
          options.abortRun?.();
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
      } catch (error) {
        options.abortRun?.();
        throw error;
      } finally {
        if (activeTimePaused) options.resumeActiveTime?.();
        await setActiveAgentUserWait(identity).catch(() => {
          // The run's terminal cleanup also clears this state. Do not replace
          // a newer run's wait after a cancellation or chat deletion race.
        });
      }
    },
  });
