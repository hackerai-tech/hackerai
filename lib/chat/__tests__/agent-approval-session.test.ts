import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { sendAgentApprovalSessionInput } from "@/lib/chat/agent-approval-session";

const originalFetch = global.fetch;
const response = (status: number) =>
  ({ ok: status >= 200 && status < 300, status }) as Response;

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("sendAgentApprovalSessionInput", () => {
  it("sends the decision to the authenticated HackerAI route", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response(200));
    global.fetch = fetchMock;

    await sendAgentApprovalSessionInput({
      chatId: "chat with spaces",
      sessionId: "approval-session",
      accessToken: "must-not-leave-browser",
      partId: "approval-part",
      value: { type: "agent-tool-approval", decision: "approve" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/approval",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          chatId: "chat with spaces",
          approvalSessionId: "approval-session",
          partId: "approval-part",
          value: { type: "agent-tool-approval", decision: "approve" },
        }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "must-not-leave-browser",
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "api.trigger.dev",
    );
  });

  it("surfaces server authorization failures", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(response(409));

    await expect(
      sendAgentApprovalSessionInput({
        chatId: "chat-1",
        sessionId: "approval-session",
        accessToken: "legacy-token",
        partId: "approval-part",
        value: { decision: "approve" },
      }),
    ).rejects.toThrow("Agent approval request failed: 409");
  });

  it("fails closed when the approval has no chat identity", async () => {
    global.fetch = jest.fn<typeof fetch>();

    await expect(
      sendAgentApprovalSessionInput({
        sessionId: "approval-session",
        accessToken: "legacy-token",
        partId: "approval-part",
        value: { decision: "approve" },
      }),
    ).rejects.toThrow("missing its chat identity");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("links the server request to the caller abort signal", async () => {
    const callerAbort = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    global.fetch = jest
      .fn<typeof fetch>()
      .mockImplementation((_input, init) => {
        requestSignal = init?.signal;
        return new Promise((_, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      });

    const send = sendAgentApprovalSessionInput({
      chatId: "chat-1",
      sessionId: "approval-session",
      accessToken: "legacy-token",
      partId: "approval-part",
      value: { decision: "approve" },
      signal: callerAbort.signal,
    });
    const rejection = expect(send).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    callerAbort.abort();

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
