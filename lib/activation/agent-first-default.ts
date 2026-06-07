import type { ChatMode, SandboxPreference } from "@/types/chat";
import type { SubscriptionTier } from "@/types";

export type AgentFirstDefaultEligibility = {
  chatMode: ChatMode;
  defaultLocalSandboxPreference: SandboxPreference | null;
  hasLocalSandbox: boolean;
  hasSavedChatMode: boolean;
  hasUserSelectedModeThisSession: boolean;
  isCheckingProPlan: boolean;
  isMobile: boolean | undefined;
  subscription: SubscriptionTier;
  temporaryChatsEnabled: boolean;
  userPresent: boolean;
};

export function shouldDefaultFreeUserToAgent({
  chatMode,
  defaultLocalSandboxPreference,
  hasLocalSandbox,
  hasSavedChatMode,
  hasUserSelectedModeThisSession,
  isCheckingProPlan,
  isMobile,
  subscription,
  temporaryChatsEnabled,
  userPresent,
}: AgentFirstDefaultEligibility): boolean {
  return (
    userPresent &&
    subscription === "free" &&
    !isCheckingProPlan &&
    isMobile === false &&
    !temporaryChatsEnabled &&
    chatMode === "ask" &&
    !hasSavedChatMode &&
    !hasUserSelectedModeThisSession &&
    hasLocalSandbox &&
    Boolean(defaultLocalSandboxPreference)
  );
}
