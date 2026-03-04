import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { agentWorkflow } from "@/workflows/agent-workflow";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import type { NextRequest } from "next/server";

// Only needs to cover the start() call and pre-processing, not the full agent execution.
// The actual agent runs inside the Workflow step (up to 1 hour).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const payload = await prepareAgentPayload(req, "agent");

    const run = await start(agentWorkflow, [payload]);

    const posthog = PostHogClient();
    if (posthog) {
      posthog.capture({
        distinctId: payload.userId,
        event: "hackerai-agent-workflow",
        properties: {
          regenerate: payload.regenerate,
          ...(payload.subscription && { subscription: payload.subscription }),
        },
      });
      await posthog.flush();
    }

    return createUIMessageStreamResponse({
      stream: run.readable,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    throw error;
  }
}
