import { v5 as uuidv5 } from "uuid";
import type {
  AgentPermissionMode,
  ChatMode,
  SubscriptionTier,
} from "@/types/chat";

export const ASK_TO_AGENT_APPROVAL_FLAG_KEY = "hac45-ask-to-agent-approval-v1";
export const ASK_TO_AGENT_APPROVAL_EXPERIMENT_KEY =
  "hac45_ask_to_agent_approval_v1";
export const ASK_TO_AGENT_APPROVAL_EXPOSURE_EVENT =
  "ask_to_agent_approval_experiment_exposed";

export const ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW = {
  start: "2026-07-14T02:08:00.000Z",
  end: "2026-07-21T02:08:00.000Z",
  eligibleUsers: 452,
  cohortUsers: 113,
  rolloutPercentage: 25,
} as const;

const EXPOSURE_STORAGE_PREFIX = "hackerai:hac45-ask-agent-exposure:v1";

type CaptureExposure = (
  event: string,
  properties: Record<string, unknown>,
  options: { uuid: string },
) => boolean;

type ApplyAskToAgentApprovalExperimentArgs = {
  agentPermissionMode: AgentPermissionMode;
  captureExposure: CaptureExposure;
  chatMode: ChatMode;
  enabled: boolean;
  now?: () => Date;
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setChatMode: (mode: ChatMode) => void;
  subscription: SubscriptionTier;
  temporaryChatsEnabled: boolean;
  userId: string;
};

const exposureStorageKey = (userId: string) =>
  `${EXPOSURE_STORAGE_PREFIX}:${uuidv5(userId, uuidv5.URL)}`;

export function hasAskToAgentApprovalExposure(userId: string): boolean {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(exposureStorageKey(userId)) !== null;
  } catch {
    return false;
  }
}

function rememberAskToAgentApprovalExposure(
  userId: string,
  exposedAt: string,
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(exposureStorageKey(userId), exposedAt);
  } catch {
    // The deterministic event UUID still deduplicates repeated exposure
    // captures when storage is unavailable.
  }
}

export function applyAskToAgentApprovalExperiment({
  agentPermissionMode,
  captureExposure,
  chatMode,
  enabled,
  now = () => new Date(),
  setAgentPermissionMode,
  setChatMode,
  subscription,
  temporaryChatsEnabled,
  userId,
}: ApplyAskToAgentApprovalExperimentArgs): boolean {
  if (
    !enabled ||
    subscription === "free" ||
    temporaryChatsEnabled ||
    hasAskToAgentApprovalExposure(userId)
  ) {
    return false;
  }

  const exposedAt = now().toISOString();
  const captured = captureExposure(
    ASK_TO_AGENT_APPROVAL_EXPOSURE_EVENT,
    {
      experiment_key: ASK_TO_AGENT_APPROVAL_EXPERIMENT_KEY,
      feature_flag_key: ASK_TO_AGENT_APPROVAL_FLAG_KEY,
      variant: "agent_ask_approval",
      exposure_event_version: 1,
      exposure_surface: "global_state",
      previous_chat_mode: chatMode,
      previous_agent_permission_mode: agentPermissionMode,
      mode: "agent",
      agent_permission_mode: "ask_approval",
      subscription,
      eligibility_window_start: ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW.start,
      eligibility_window_end: ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW.end,
      eligible_user_denominator:
        ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW.eligibleUsers,
      cohort_user_count: ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW.cohortUsers,
      rollout_percentage:
        ASK_TO_AGENT_APPROVAL_ELIGIBILITY_WINDOW.rolloutPercentage,
      $set_once: {
        ask_to_agent_approval_experiment_variant: "agent_ask_approval",
        ask_to_agent_approval_experiment_exposed_at: exposedAt,
      },
    },
    {
      uuid: uuidv5(
        `${ASK_TO_AGENT_APPROVAL_EXPERIMENT_KEY}:${userId}`,
        uuidv5.URL,
      ),
    },
  );

  if (!captured) return false;

  rememberAskToAgentApprovalExposure(userId, exposedAt);
  setAgentPermissionMode("ask_approval");
  setChatMode("agent");
  return true;
}
