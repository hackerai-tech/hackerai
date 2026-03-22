import { generateId } from "ai";
import { runAgentStep, closeWorkflowStream } from "./agent-step";
import { WORKFLOW_CHECKPOINT_FINISH_REASON } from "@/lib/chat/stop-conditions";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";
const MAX_CONTINUATIONS = 50;

/**
 * Vercel Workflow for durable agent execution.
 * Orchestrates steps that run the full agent loop (streamText + tools).
 * This removes the 800s Vercel function timeout — workflows can run up to 1 hour.
 *
 * If the agent loop hits the time budget, the step returns a
 * "workflow-checkpoint" finish reason and the workflow loops to continue
 * in a fresh step with the same session context.
 *
 * Each step calls getWritable() internally to get a writable connected to
 * the current execution context. This is required because durable execution
 * re-runs the workflow function between steps — a writable obtained at the
 * workflow level may not survive the re-execution boundary.
 */
export async function agentWorkflow(input: AgentTaskPayload) {
  "use workflow";

  let payload = input;
  let continuations = 0;

  while (continuations < MAX_CONTINUATIONS) {
    const result = await runAgentStep(payload);

    if (result.finishReason !== WORKFLOW_CHECKPOINT_FINISH_REASON) break;
    if (!result.messagesSnapshot?.length) break;

    continuations++;
    payload = {
      ...input,
      messages: result.messagesSnapshot,
      chatFinishReason: WORKFLOW_CHECKPOINT_FINISH_REASON,
      isNewChat: false,
      regenerate: false,
      assistantMessageId: generateId(),
      sandboxFiles: undefined,
      hasSandboxFiles: false,
    };
  }

  // Safety net: if the loop exited because MAX_CONTINUATIONS was reached,
  // the last step was a checkpoint and left the stream open. Close it.
  if (continuations >= MAX_CONTINUATIONS) {
    await closeWorkflowStream(input.chatId);
  }
}
