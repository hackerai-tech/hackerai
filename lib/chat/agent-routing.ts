import type { ChatMode } from "@/types";

const HACKERAI_DESKTOP_USER_AGENT_TOKEN = "HackerAI-Desktop";

export const LEGACY_DESKTOP_AGENT_UPDATE_MESSAGE =
  "Agent mode now requires the latest HackerAI Desktop app. Please update HackerAI Desktop, then try again.";

export function isHackerAIDesktopUserAgent(
  userAgent: string | null | undefined = getBrowserUserAgent(),
): boolean {
  return userAgent?.includes(HACKERAI_DESKTOP_USER_AGENT_TOKEN) ?? false;
}

export function isLegacyDesktopAgentClient({
  mode,
  isTauri,
  userAgent,
}: {
  mode: ChatMode | string;
  isTauri: boolean;
  userAgent?: string | null;
}): boolean {
  return mode === "agent" && isTauri && !isHackerAIDesktopUserAgent(userAgent);
}

export function shouldUseAgentLongForAgent({
  mode,
  isTauri,
  userAgent,
}: {
  mode: ChatMode | string;
  subscription?: string | null;
  isTauri: boolean;
  userAgent?: string | null;
}): boolean {
  if (mode !== "agent") return false;

  return !isLegacyDesktopAgentClient({ mode, isTauri, userAgent });
}

function getBrowserUserAgent(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent;
}
