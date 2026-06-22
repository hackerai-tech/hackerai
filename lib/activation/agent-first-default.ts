import type { ChatMode, SandboxPreference } from "@/types/chat";
import type { SubscriptionTier } from "@/types";

export type AgentFirstSandboxType =
  | "desktop"
  | "remote-connection"
  | "e2b"
  | "none";

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

export function normalizeAgentFirstSandboxType(
  preference: SandboxPreference | null,
): AgentFirstSandboxType {
  if (!preference) return "none";
  if (preference === "desktop") return "desktop";
  if (preference === "e2b") return "e2b";
  return "remote-connection";
}

export function shouldDefaultFreeUserToAgent({
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
}: AgentFirstDefaultEligibility): boolean {
  return (
    userPresent &&
    subscriptionResolved &&
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
