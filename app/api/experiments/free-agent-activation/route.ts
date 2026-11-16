import { after, type NextRequest } from "next/server";
import PostHogClient from "@/app/posthog";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import {
  evaluateFreeAgentActivationForStatus,
  getFreeAgentActivationStatus,
} from "@/lib/activation/free-agent-activation.server";

const NO_STORE = { "Cache-Control": "private, no-store" };

const unavailable = () =>
  Response.json({ status: null }, { status: 503, headers: NO_STORE });

/**
 * Returns only the client-safe status; lookup is not exposure. `200 null` is
 * a known exclusion; `503` means the status is unknown, so clients must not
 * treat it as "not enrolled".
 */
export async function GET(req: NextRequest) {
  try {
    const identity = await getUserIDAndPro(req);
    const posthog = PostHogClient();
    const enrollment = await evaluateFreeAgentActivationForStatus({
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
    if (enrollment === undefined) return unavailable();
    const status = await getFreeAgentActivationStatus(enrollment);
    if (status === undefined) return unavailable();
    return Response.json({ status }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      const response = error.toResponse();
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    return unavailable();
  }
}
