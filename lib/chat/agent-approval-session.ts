import { AGENT_APPROVAL_ENDPOINT } from "@/lib/api/agent-endpoints";

const APPROVAL_SESSION_SEND_TIMEOUT_MS = 30_000;

const createSendAbortController = (signal?: AbortSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  const timeoutId = setTimeout(abort, APPROVAL_SESSION_SEND_TIMEOUT_MS);
  return {
    controller,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    },
  };
};

export async function sendAgentApprovalSessionInput({
  chatId,
  sessionId,
  partId,
  value,
  signal,
}: {
  chatId?: string;
  sessionId: string;
  accessToken: string;
  partId: string;
  value: unknown;
  signal?: AbortSignal;
  onAccessTokenRefreshed?: (accessToken: string) => void;
}): Promise<void> {
  if (!chatId) {
    throw new Error("Agent approval is missing its chat identity.");
  }

  const sendAbort = createSendAbortController(signal);
  let response: Response;
  try {
    response = await fetch(AGENT_APPROVAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        approvalSessionId: sessionId,
        partId,
        value,
      }),
      cache: "no-store",
      credentials: "same-origin",
      signal: sendAbort.controller.signal,
    });
  } finally {
    sendAbort.cleanup();
  }

  if (!response.ok) {
    throw new Error(`Agent approval request failed: ${response.status}`);
  }
}
