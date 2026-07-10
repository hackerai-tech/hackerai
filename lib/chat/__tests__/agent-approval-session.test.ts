import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { sendAgentApprovalSessionInput } from "@/lib/chat/agent-approval-session";
import { TriggerSessionInputHttpError } from "@/lib/chat/trigger-browser-realtime";

const originalFetch = global.fetch;

const response = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  }) as unknown as Response;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("sendAgentApprovalSessionInput", () => {
  it("refreshes an expired token through the owner-checked resume route", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(
        response(200, {
          runId: "run_123",
          publicAccessToken: "run-token",
          approvalSessionId: "approval-session",
          approvalSessionPublicAccessToken: "fresh-approval-token",
        }),
      )
      .mockResolvedValueOnce(response(200));
    global.fetch = fetchMock;
    const onAccessTokenRefreshed = jest.fn();

    await sendAgentApprovalSessionInput({
      chatId: "chat with spaces",
      sessionId: "approval-session",
      accessToken: "expired-approval-token",
      partId: "approval-part",
      value: { decision: "approve" },
      onAccessTokenRefreshed,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/agent/resume?chatId=chat%20with%20spaces",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer expired-approval-token",
        "X-Part-Id": "approval-part",
      }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer fresh-approval-token",
        "X-Part-Id": "approval-part",
      }),
    });
    expect(onAccessTokenRefreshed).toHaveBeenCalledWith("fresh-approval-token");
  });

  it("rejects a refresh that points at a different approval session", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(
        response(200, {
          approvalSessionId: "replacement-session",
          approvalSessionPublicAccessToken: "replacement-token",
        }),
      );
    global.fetch = fetchMock;

    await expect(
      sendAgentApprovalSessionInput({
        chatId: "chat-1",
        sessionId: "approval-session",
        accessToken: "expired-token",
        partId: "approval-part",
        value: { decision: "approve" },
      }),
    ).rejects.toThrow("approval session changed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a terminal run instead of parsing an empty 204 response", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(204));
    global.fetch = fetchMock;

    await expect(
      sendAgentApprovalSessionInput({
        chatId: "chat-1",
        sessionId: "approval-session",
        accessToken: "expired-token",
        partId: "approval-part",
        value: { decision: "approve" },
      }),
    ).rejects.toThrow("no longer waiting for approval");
  });

  it("cannot refresh a legacy session that has no chat identity", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValueOnce(response(401));

    await expect(
      sendAgentApprovalSessionInput({
        sessionId: "approval-session",
        accessToken: "expired-token",
        partId: "approval-part",
        value: { decision: "approve" },
      }),
    ).rejects.toBeInstanceOf(TriggerSessionInputHttpError);
  });
});
