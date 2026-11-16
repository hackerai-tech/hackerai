import { after, type NextRequest } from "next/server";
import PostHogClient from "@/app/posthog";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import {
  evaluateFreeAgentActivation,
  getFreeAgentActivationStatus,
} from "@/lib/activation/free-agent-activation.server";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** Returns only the client-safe status; lookup is not exposure. */
export async function GET(req: NextRequest) {
  try {
    const identity = await getUserIDAndPro(req);
    const posthog = PostHogClient();
    const enrollment = await evaluateFreeAgentActivation({
      request: req,
      identity,
      posthog,
    });
    if (posthog) {
      try {
        // Deliver the queued assignment event without delaying the response.
        after(() => posthog.shutdown());
      } catch {
        // Telemetry delivery must not change the status response.
      }
    }
    const status = await getFreeAgentActivationStatus(enrollment);
    return Response.json({ status }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      const response = error.toResponse();
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    return Response.json({ status: null }, { status: 503, headers: NO_STORE });
  }
}
