import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type {
  LocalAutoContinueReason,
  LocalAutoContinueState,
  LocalAutoContinueVariant,
} from "@/lib/chat/local-auto-continue";

/** HAC-275 experiment: control keeps the manual Resume prompt. */
export const AGENT_LOCAL_AUTO_CONTINUE_FLAG = "agent-local-auto-continue-v1";
export const AGENT_LOCAL_AUTO_CONTINUE_EXPOSURE_EVENT =
  "agent_local_auto_continue_exposed";
export const AGENT_LOCAL_AUTO_CONTINUE_OUTCOME_EVENT =
  "agent_local_auto_continue_outcome";

/**
 * The user's arm, without recording exposure. Undefined means the flag was
 * absent or unavailable: the caller behaves as control and records no
 * exposure, so the experiment only counts real assignments.
 */
export async function getLocalAutoContinueVariant(
  userId: string,
  posthog: Pick<PostHog, "getFeatureFlagResult"> | null,
): Promise<LocalAutoContinueVariant | undefined> {
  if (!userId || !posthog) return undefined;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      AGENT_LOCAL_AUTO_CONTINUE_FLAG,
      userId,
    );
    return variant === "control" || variant === "test" ? variant : undefined;
  } catch {
    return undefined;
  }
}

/** Closed, content-free fields shared by every auto-continue event. */
export type LocalAutoContinueEventContext = {
  userId: string;
  chatId: string;
  stoppedRunId: string;
  stopReason?: string;
  stoppedAt?: number;
  variant?: LocalAutoContinueVariant;
};

export type LocalAutoContinueOutcome = Exclude<
  LocalAutoContinueState,
  "awaiting_return" | "starting"
>;

const baseProperties = (context: LocalAutoContinueEventContext) => ({
  telemetry_version: 1,
  chat_id: context.chatId,
  stopped_run_id: context.stoppedRunId,
  ...(context.stopReason && { local_stop_reason: context.stopReason }),
  ...(context.stoppedAt !== undefined && {
    stop_age_ms: Math.max(0, Date.now() - context.stoppedAt),
  }),
  ...(context.variant && {
    experiment_key: AGENT_LOCAL_AUTO_CONTINUE_FLAG,
    experiment_variant: context.variant,
    [`$feature/${AGENT_LOCAL_AUTO_CONTINUE_FLAG}`]: context.variant,
  }),
  $geoip_disable: true,
  $process_person_profile: false,
});

/**
 * Records analytics for one stop. Each event's UUID is derived from the stop,
 * so a retried report cannot count twice. Never throws.
 */
export function createLocalAutoContinueTelemetry(
  posthog: Pick<PostHog, "capture"> | null,
) {
  const capture = (
    event: string,
    key: readonly string[],
    properties: Record<string, unknown>,
    userId: string,
  ) => {
    try {
      posthog?.capture({
        distinctId: userId,
        event,
        uuid: uuidv5(JSON.stringify([event, ...key]), uuidv5.URL),
        properties,
      });
    } catch {
      // Analytics must not change whether a run continues.
    }
  };
  return {
    /** Both arms, once per stop, when its own computer came back in time. */
    exposed(
      context: LocalAutoContinueEventContext & {
        variant: LocalAutoContinueVariant;
      },
    ) {
      capture(
        AGENT_LOCAL_AUTO_CONTINUE_EXPOSURE_EVENT,
        [context.stoppedRunId],
        { ...baseProperties(context), exposure_surface: "desktop_return" },
        context.userId,
      );
    },
    outcome(
      outcome: LocalAutoContinueOutcome,
      context: LocalAutoContinueEventContext & {
        reason?: LocalAutoContinueReason;
        continuedRunId?: string;
      },
    ) {
      capture(
        AGENT_LOCAL_AUTO_CONTINUE_OUTCOME_EVENT,
        [context.stoppedRunId, outcome],
        {
          ...baseProperties(context),
          outcome,
          ...(context.reason && { reason: context.reason }),
          ...(context.continuedRunId && {
            continued_run_id: context.continuedRunId,
          }),
        },
        context.userId,
      );
    },
  };
}
