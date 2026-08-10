import { NextRequest, NextResponse } from "next/server";
import PostHogClient from "@/app/posthog";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getUserCustomization } from "@/lib/db/actions";
import { buildExtraUsageConfig } from "@/lib/api/chat-stream-helpers";
import { canUseExtraUsage } from "@/types";
import {
  evaluateProPlusMaxAccessExperiment,
  PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
} from "@/lib/experiments/pro-plus-max-access";
import { shutdownPostHog } from "@/lib/api/chat-logger";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  let posthog: ReturnType<typeof PostHogClient> = null;

  try {
    const { userId, subscription, organizationId } = await getUserIDAndPro(req);

    if (subscription !== "pro-plus") {
      return NextResponse.json(
        { eligible: false, includedMaxAccess: false },
        { headers: NO_STORE_HEADERS },
      );
    }

    const userCustomization = await getUserCustomization({ userId });
    const extraUsageConfig = await buildExtraUsageConfig({
      userId,
      subscription,
      userCustomization,
      organizationId,
    });
    const extraUsageAvailable = canUseExtraUsage(extraUsageConfig);

    if (extraUsageAvailable) {
      return NextResponse.json(
        { eligible: false, includedMaxAccess: false },
        { headers: NO_STORE_HEADERS },
      );
    }

    posthog = PostHogClient();
    const assignment = await evaluateProPlusMaxAccessExperiment({
      posthog,
      userId,
      subscription,
      mode: "agent",
      extraUsageAvailable,
      captureExposure: true,
    });

    return NextResponse.json(
      {
        eligible: assignment !== undefined,
        experimentKey: assignment?.key ?? PRO_PLUS_MAX_ACCESS_EXPERIMENT_KEY,
        variant: assignment?.variant,
        includedMaxAccess: assignment?.includedMaxAccess ?? false,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.warn("Failed to resolve Pro+ Max access experiment", {
      event: "pro_plus_max_access_experiment_route_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { eligible: false, includedMaxAccess: false },
      { headers: NO_STORE_HEADERS },
    );
  } finally {
    shutdownPostHog(posthog);
  }
}
