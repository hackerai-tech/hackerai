import { tasks, auth } from "@trigger.dev/sdk/v3";
import type { agentStreamTask } from "@/src/trigger/agent-task";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import type { NextRequest } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const payload = await prepareAgentPayload(req);

    const handle = await tasks.trigger<typeof agentStreamTask>(
      "agent-stream",
      payload,
    );

    const publicAccessToken = await auth.createPublicToken({
      scopes: {
        read: { runs: [handle.id] },
      },
      expirationTime: "1hr",
    });

    return Response.json({
      runId: handle.id,
      publicAccessToken,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    throw error;
  }
}
