import { getWritable } from "workflow";
import { generateId, type UIMessageChunk } from "ai";
import { runAgentStep } from "./agent-step";
import { WORKFLOW_CHECKPOINT_FINISH_REASON } from "@/lib/chat/stop-conditions";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";

const MAX_CONTINUATIONS = 50;

/**
 * Vercel Workflow for durable agent execution.
 * Orchestrates a single step that runs the full agent loop (streamText + tools).
 * This removes the 800s Vercel function timeout — workflows can run up to 1 hour.
 *
 * If the agent loop hits the 750s time budget, the step returns a
 * "workflow-checkpoint" finish reason and the workflow loops to continue
 * in a fresh step with the same session context.
 *
 * The writable stream is obtained at the workflow level and passed into each
 * step. Steps pipe into it with preventClose so the stream stays open across
 * continuations. The writable is only closed here after the loop exits.
 */
export async function agentWorkflow(input: AgentTaskPayload) {
  "use workflow";

  const writable = getWritable<UIMessageChunk>();

  let payload = input;
  let continuations = 0;

  while (continuations < MAX_CONTINUATIONS) {
    const result = await runAgentStep(payload, writable);

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

  // Send the finish event that steps intentionally strip, then close.
  const writer = writable.getWriter();
  await writer.write({ type: "finish", finishReason: "stop" });
  writer.releaseLock();
  await writable.close();
}
