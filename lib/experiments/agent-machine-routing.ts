import type { SubscriptionTier } from "@/types";

export const AGENT_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG =
  "agent_lightweight_small_1x_v1";
export const AGENT_MACHINE_ROUTING_EXPOSURE_EVENT =
  "agent_machine_routing_exposed";
export const AGENT_LIGHTWEIGHT_REQUEST_MAX_BYTES = 32 * 1024;
export const AGENT_MACHINE_ROUTING_FLAG_TIMEOUT_MS = 100;

export type AgentTriggerMachinePreset = "small-1x" | "small-2x";

export type AgentLightweightMachineEligibilityReason =
  | "eligible"
  | "unsupported_subscription"
  | "existing_chat"
  | "regenerate"
  | "auto_continue"
  | "automatic_continuation"
  | "limit_rescue"
  | "request_message_count"
  | "request_too_large"
  | "file_attachment"
  | "desktop_local_attachment"
  | "project_context"
  | "existing_todos";

export type AgentLightweightMachineEligibility = {
  eligible: boolean;
  reason: AgentLightweightMachineEligibilityReason;
};

export type AgentMachineRoutingVariant = "ineligible" | "control" | "test";

export type AgentMachineRoutingDecision = {
  eligible: boolean;
  reason: AgentLightweightMachineEligibilityReason;
  variant: AgentMachineRoutingVariant;
  machine: AgentTriggerMachinePreset;
};

const AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION: Record<
  SubscriptionTier,
  AgentTriggerMachinePreset
> = {
  free: "small-1x",
  // Paid baselines stay on the 1 GB worker. Only a flag-enabled request that
  // passes every conservative first-turn guard below may use small-1x.
  pro: "small-2x",
  "pro-plus": "small-2x",
  ultra: "small-2x",
  team: "small-2x",
};

/** Return the established subscription machine when no treatment applies. */
export function getBaselineAgentTriggerMachine(
  subscription: SubscriptionTier,
): AgentTriggerMachinePreset {
  return AGENT_TRIGGER_MACHINE_BY_SUBSCRIPTION[subscription];
}

/** Return the first failed safety guard, or mark the request treatment-eligible. */
export function getAgentLightweightMachineEligibility({
  subscription,
  isNewChat,
  regenerate,
  isAutoContinue,
  isAutomaticContinuation,
  hasLimitRescue,
  requestMessageCount,
  requestMessageBytes,
  hasFileAttachment,
  localDesktopAttachmentsPrepared,
  hasProjectContext,
  hasTodos,
}: {
  subscription: SubscriptionTier;
  isNewChat: boolean;
  regenerate: boolean;
  isAutoContinue: boolean;
  isAutomaticContinuation: boolean;
  hasLimitRescue: boolean;
  requestMessageCount: number;
  requestMessageBytes: number;
  hasFileAttachment: boolean;
  localDesktopAttachmentsPrepared: boolean;
  hasProjectContext: boolean;
  hasTodos: boolean;
}): AgentLightweightMachineEligibility {
  if (subscription !== "pro" && subscription !== "pro-plus") {
    return { eligible: false, reason: "unsupported_subscription" };
  }
  if (regenerate) return { eligible: false, reason: "regenerate" };
  if (isAutomaticContinuation) {
    return { eligible: false, reason: "automatic_continuation" };
  }
  if (isAutoContinue) return { eligible: false, reason: "auto_continue" };
  if (hasLimitRescue) return { eligible: false, reason: "limit_rescue" };
  if (!isNewChat) return { eligible: false, reason: "existing_chat" };
  if (requestMessageCount !== 1) {
    return { eligible: false, reason: "request_message_count" };
  }
  if (requestMessageBytes > AGENT_LIGHTWEIGHT_REQUEST_MAX_BYTES) {
    return { eligible: false, reason: "request_too_large" };
  }
  if (hasFileAttachment) {
    return { eligible: false, reason: "file_attachment" };
  }
  if (localDesktopAttachmentsPrepared) {
    return { eligible: false, reason: "desktop_local_attachment" };
  }
  if (hasProjectContext) {
    return { eligible: false, reason: "project_context" };
  }
  if (hasTodos) return { eligible: false, reason: "existing_todos" };

  return { eligible: true, reason: "eligible" };
}

/** Resolve one machine decision shared by direct tasks and approval Sessions. */
export function resolveAgentMachineRouting({
  subscription,
  eligibility,
  lightweightSmall1xEnabled,
}: {
  subscription: SubscriptionTier;
  eligibility: AgentLightweightMachineEligibility;
  lightweightSmall1xEnabled: boolean;
}): AgentMachineRoutingDecision {
  if (!eligibility.eligible) {
    return {
      ...eligibility,
      variant: "ineligible",
      machine: getBaselineAgentTriggerMachine(subscription),
    };
  }

  return {
    ...eligibility,
    variant: lightweightSmall1xEnabled ? "test" : "control",
    machine: lightweightSmall1xEnabled ? "small-1x" : "small-2x",
  };
}

/** Bound remote flag latency and fail closed to the existing paid baseline. */
export async function getAgentMachineRoutingFlagBeforeDeadline(
  evaluation: Promise<boolean>,
  timeoutMs = AGENT_MACHINE_ROUTING_FLAG_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Build content-free exposure properties only after an eligible run is scheduled. */
export function getAgentMachineRoutingExposure({
  decision,
  subscription,
  endpoint,
  runId,
  isNewChat,
  requestMessageCount,
  requestMessageBytes,
  requestHasFileAttachments,
  localDesktopAttachmentsPrepared,
}: {
  decision: AgentMachineRoutingDecision;
  subscription: SubscriptionTier;
  endpoint: string;
  runId: string;
  isNewChat: boolean;
  requestMessageCount: number;
  requestMessageBytes: number;
  requestHasFileAttachments: boolean;
  localDesktopAttachmentsPrepared: boolean;
}):
  | {
      event: typeof AGENT_MACHINE_ROUTING_EXPOSURE_EVENT;
      properties: Record<string, unknown>;
    }
  | undefined {
  if (!decision.eligible || decision.variant === "ineligible") {
    return undefined;
  }

  return {
    event: AGENT_MACHINE_ROUTING_EXPOSURE_EVENT,
    properties: {
      experiment_key: AGENT_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG,
      experiment_variant: decision.variant,
      [`$feature/${AGENT_LIGHTWEIGHT_SMALL_1X_FEATURE_FLAG}`]:
        decision.variant === "test",
      subscription,
      subscription_tier: subscription,
      endpoint,
      trigger_run_id: runId,
      selected_machine: decision.machine,
      machine_routing_eligible: true,
      machine_routing_eligibility_reason: decision.reason,
      is_new_chat: isNewChat,
      request_message_count: requestMessageCount,
      request_message_bytes: requestMessageBytes,
      request_has_file_attachments: requestHasFileAttachments,
      local_desktop_attachments_prepared: localDesktopAttachmentsPrepared,
      exposure_surface: "trigger_schedule",
      $process_person_profile: false,
    },
  };
}
