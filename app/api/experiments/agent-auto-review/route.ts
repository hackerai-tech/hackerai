import { NextRequest, NextResponse } from "next/server";

import PostHogClient from "@/app/posthog";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { shutdownPostHog } from "@/lib/api/chat-logger";
import {
  AGENT_AUTO_REVIEW_FLAG_KEY,
  evaluateAgentAutoReviewFlag,
} from "@/lib/experiments/agent-auto-review";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  let posthog: ReturnType<typeof PostHogClient> = null;

  try {
    const { userId } = await getUserIDAndPro(req);
    posthog = PostHogClient();
    const assignment = await evaluateAgentAutoReviewFlag({
      posthog,
      userId,
      captureExposure: true,
      surface: "agent_permission_selector",
    });

    return NextResponse.json(
      {
        available: assignment !== undefined,
        flagKey: AGENT_AUTO_REVIEW_FLAG_KEY,
        phase: assignment?.phase,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.warn("Failed to resolve Agent Auto review flag", {
      event: "agent_auto_review_flag_route_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { available: false, flagKey: AGENT_AUTO_REVIEW_FLAG_KEY },
      { headers: NO_STORE_HEADERS },
    );
  } finally {
    shutdownPostHog(posthog);
  }
}
