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

export type AgentFirstDefaultDecision = {
  eligibleSubscriptionTier: "free" | "pro-plus" | "ultra";
  experimentKey:
    | "free_agent_first_v1"
    | "pro_plus_agent_default_v1"
    | "ultra_agent_default_v1";
  selectionReason:
    | "eligible_free_user_local_sandbox"
    | "eligible_pro_plus_user"
    | "eligible_ultra_user";
  useDefaultLocalSandbox: boolean;
};

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

  if (subscription === "ultra") {
    return {
      eligibleSubscriptionTier: "ultra",
      experimentKey: "ultra_agent_default_v1",
      selectionReason: "eligible_ultra_user",
      useDefaultLocalSandbox: false,
    };
  }

  if (subscription === "pro-plus") {
    return {
      eligibleSubscriptionTier: "pro-plus",
      experimentKey: "pro_plus_agent_default_v1",
      selectionReason: "eligible_pro_plus_user",
      useDefaultLocalSandbox: false,
    };
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
