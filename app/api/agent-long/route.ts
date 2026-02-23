import { tasks } from "@trigger.dev/sdk/v3";
import type { agentStreamTask } from "@/src/trigger/agent-task";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import PostHogClient from "@/app/posthog";
import type { NextRequest } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const payload = await prepareAgentPayload(req);

    const handle = await tasks.trigger<typeof agentStreamTask>(
      "agent-stream",
      payload,
      {
        publicTokenOptions: { expirationTime: "1hr" },
      } as Parameters<typeof tasks.trigger>[2],
    );

    const posthog = PostHogClient();
    if (posthog) {
      posthog.capture({
        distinctId: payload.userId,
        event: "hackerai-agent-long",
        properties: {
          regenerate: payload.regenerate,
          ...(payload.subscription && { subscription: payload.subscription }),
        },
      });
      try {
        await posthog.flush();
      } catch (flushError) {
        console.error("PostHog flush failed after trigger", flushError);
      }
    }

    return Response.json({
      runId: handle.id,
      publicAccessToken: handle.publicAccessToken,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error("agent-long POST error", error);
    return Response.json(
      {
        message: "Service temporarily unavailable. Please try again.",
        code: "SERVICE_ERROR",
      },
      { status: 503 },
    );
  }
}
