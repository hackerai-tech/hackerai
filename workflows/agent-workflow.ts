import { runAgentStep } from "./agent-step";
import type { AgentTaskPayload } from "@/lib/api/prepare-agent-payload";

/**
 * Vercel Workflow for durable agent execution.
 * Orchestrates a single step that runs the full agent loop (streamText + tools).
 * This removes the 800s Vercel function timeout — workflows can run up to 1 hour.
 *
 * The workflow itself is deterministic and side-effect-free.
 * All I/O (LLM calls, tool execution, DB writes) happens inside the step.
 */
export async function agentWorkflow(input: AgentTaskPayload) {
  "use workflow";

  await runAgentStep(input);
}
