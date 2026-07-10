import { AGENT_RESUME_ENDPOINT } from "@/lib/api/agent-endpoints";
import {
  isTriggerSessionInputAuthorizationError,
  sendTriggerSessionInput,
} from "@/lib/chat/trigger-browser-realtime";

type AgentApprovalResumeHandle = {
  approvalSessionId?: unknown;
  approvalSessionPublicAccessToken?: unknown;
};

export async function sendAgentApprovalSessionInput({
  chatId,
  sessionId,
  accessToken,
  partId,
  value,
  signal,
  onAccessTokenRefreshed,
}: {
  chatId?: string;
  sessionId: string;
  accessToken: string;
  partId: string;
  value: unknown;
  signal?: AbortSignal;
  onAccessTokenRefreshed?: (accessToken: string) => void;
}): Promise<void> {
  const append = (token: string) =>
    sendTriggerSessionInput({
      sessionId,
      accessToken: token,
      partId,
      value,
      signal,
    });

  let authorizationError: unknown;
  try {
    await append(accessToken);
    return;
  } catch (error) {
    if (!isTriggerSessionInputAuthorizationError(error)) throw error;
    authorizationError = error;
  }

  if (!chatId) throw authorizationError;

  const resumeUrl = `${AGENT_RESUME_ENDPOINT}?chatId=${encodeURIComponent(
    chatId,
  )}`;
  const response = await fetch(resumeUrl, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (response.status === 204) {
    throw new Error("The Agent run is no longer waiting for approval.");
  }
  if (!response.ok) {
    throw new Error(
      `Agent approval session refresh failed: ${response.status}`,
    );
  }

  const handle = (await response.json()) as AgentApprovalResumeHandle;
  if (handle.approvalSessionId !== sessionId) {
    throw new Error("Agent approval session changed before approval was sent.");
  }
  if (typeof handle.approvalSessionPublicAccessToken !== "string") {
    throw new Error("Agent approval session refresh returned no access token.");
  }

  onAccessTokenRefreshed?.(handle.approvalSessionPublicAccessToken);
  await append(handle.approvalSessionPublicAccessToken);
}
