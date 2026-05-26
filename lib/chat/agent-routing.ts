import type { ChatMode } from "@/types";

const HACKERAI_DESKTOP_USER_AGENT_TOKEN = "HackerAI-Desktop";

export function isHackerAIDesktopUserAgent(
  userAgent: string | null | undefined = getBrowserUserAgent(),
): boolean {
  return userAgent?.includes(HACKERAI_DESKTOP_USER_AGENT_TOKEN) ?? false;
}

export function shouldUseAgentLongForAgent({
  mode,
  subscription,
  isTauri,
  userAgent,
}: {
  mode: ChatMode | string;
  subscription?: string | null;
  isTauri: boolean;
  userAgent?: string | null;
}): boolean {
  if (mode !== "agent") return false;

  if (isHackerAIDesktopUserAgent(userAgent)) {
    return true;
  }

  return !isTauri || subscription === "free";
}

export function shouldUseTriggerForChat({
  mode,
  subscription,
  isTauri,
  userAgent,
}: {
  mode: ChatMode | string;
  subscription?: string | null;
  isTauri: boolean;
  userAgent?: string | null;
}): boolean {
  if (mode === "ask") {
    return !!subscription && subscription !== "free";
  }

  return shouldUseAgentLongForAgent({
    mode,
    subscription,
    isTauri,
    userAgent,
  });
}

function getBrowserUserAgent(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent;
}
