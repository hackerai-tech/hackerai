import type { ChatMode, SandboxPreference } from "@/types/chat";
import type { SubscriptionTier } from "@/types";

export type AgentFirstSandboxType =
  "desktop" | "remote-connection" | "e2b" | "none";

export type AgentFirstDefaultEligibility = {
  chatMode: ChatMode;
  defaultLocalSandboxPreference: SandboxPreference | null;
  hasLocalSandbox: boolean;
  hasSavedChatMode: boolean;
  hasUserSelectedModeThisSession: boolean;
  isCheckingProPlan: boolean;
  isMobile: boolean | undefined;
  subscription: SubscriptionTier;
  subscriptionResolved: boolean;
  temporaryChatsEnabled: boolean;
  userPresent: boolean;
};

type PaidAgentFirstDefaultTier = Exclude<SubscriptionTier, "free">;

export type AgentFirstDefaultDecision = {
  eligibleSubscriptionTier: SubscriptionTier;
  experimentKey:
    | "free_agent_first_v1"
    | "pro_agent_default_v1"
    | "pro_plus_agent_default_v1"
    | "ultra_agent_default_v1"
    | "team_agent_default_v1";
  selectionReason:
    | "eligible_free_user_local_sandbox"
    | "eligible_pro_user"
    | "eligible_pro_plus_user"
    | "eligible_ultra_user"
    | "eligible_team_user";
  useDefaultLocalSandbox: boolean;
};

const PAID_AGENT_FIRST_DEFAULTS = {
  pro: {
    eligibleSubscriptionTier: "pro",
    experimentKey: "pro_agent_default_v1",
    selectionReason: "eligible_pro_user",
    useDefaultLocalSandbox: false,
  },
  "pro-plus": {
    eligibleSubscriptionTier: "pro-plus",
    experimentKey: "pro_plus_agent_default_v1",
    selectionReason: "eligible_pro_plus_user",
    useDefaultLocalSandbox: false,
  },
  ultra: {
    eligibleSubscriptionTier: "ultra",
    experimentKey: "ultra_agent_default_v1",
    selectionReason: "eligible_ultra_user",
    useDefaultLocalSandbox: false,
  },
  team: {
    eligibleSubscriptionTier: "team",
    experimentKey: "team_agent_default_v1",
    selectionReason: "eligible_team_user",
    useDefaultLocalSandbox: false,
  },
} satisfies Record<PaidAgentFirstDefaultTier, AgentFirstDefaultDecision>;

function isPaidAgentFirstDefaultTier(
  subscription: SubscriptionTier,
): subscription is PaidAgentFirstDefaultTier {
  return subscription !== "free";
}

export function normalizeAgentFirstSandboxType(
  preference: SandboxPreference | null,
): AgentFirstSandboxType {
  if (!preference) return "none";
  if (preference === "desktop") return "desktop";
  if (preference === "e2b") return "e2b";
  return "remote-connection";
}

export function getAgentFirstDefaultDecision({
  chatMode,
  defaultLocalSandboxPreference,
  hasLocalSandbox,
  hasSavedChatMode,
  hasUserSelectedModeThisSession,
  isCheckingProPlan,
  isMobile,
  subscription,
  subscriptionResolved,
  temporaryChatsEnabled,
  userPresent,
}: AgentFirstDefaultEligibility): AgentFirstDefaultDecision | null {
  const baseEligible =
    userPresent &&
    subscriptionResolved &&
    !isCheckingProPlan &&
    !temporaryChatsEnabled &&
    chatMode === "ask" &&
    !hasSavedChatMode &&
    !hasUserSelectedModeThisSession;

  if (!baseEligible) return null;

  if (
    subscription === "free" &&
    isMobile === false &&
    hasLocalSandbox &&
    Boolean(defaultLocalSandboxPreference)
  ) {
    return {
      eligibleSubscriptionTier: "free",
      experimentKey: "free_agent_first_v1",
      selectionReason: "eligible_free_user_local_sandbox",
      useDefaultLocalSandbox: true,
    };
  }

  if (isPaidAgentFirstDefaultTier(subscription)) {
    return PAID_AGENT_FIRST_DEFAULTS[subscription];
  }

  return null;
}

export function shouldDefaultFreeUserToAgent(
  eligibility: AgentFirstDefaultEligibility,
): boolean {
  return (
    getAgentFirstDefaultDecision(eligibility)?.eligibleSubscriptionTier ===
    "free"
  );
}

export function shouldDefaultUltraUserToAgent(
  eligibility: AgentFirstDefaultEligibility,
): boolean {
  return (
    getAgentFirstDefaultDecision(eligibility)?.eligibleSubscriptionTier ===
    "ultra"
  );
}

export function shouldDefaultProPlusUserToAgent(
  eligibility: AgentFirstDefaultEligibility,
): boolean {
  return (
    getAgentFirstDefaultDecision(eligibility)?.eligibleSubscriptionTier ===
    "pro-plus"
  );
}

export function shouldDefaultPaidUserToAgent(
  eligibility: AgentFirstDefaultEligibility,
): boolean {
  const tier =
    getAgentFirstDefaultDecision(eligibility)?.eligibleSubscriptionTier;
  return tier !== undefined && tier !== "free";
}
