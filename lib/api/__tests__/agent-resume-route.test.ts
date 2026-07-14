import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockSetActiveTriggerRun = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockCreatePublicToken = jest.fn();
const mockGetTemporaryRefreshHandle = jest.fn();
const mockSetTemporaryRefreshCookie = jest.fn();
const mockClearTemporaryRefreshCookie = jest.fn();
const mockCloseAgentApprovalSession = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;
    cookies = { set: jest.fn() };

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }

    async json() {
      return this.body;
    }

    async text() {
      return typeof this.body === "string"
        ? this.body
        : JSON.stringify(this.body ?? "");
    }
  },
}));

jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class MockApiError extends Error {
    status?: number;
  },
  runs: { retrieve: mockRunsRetrieve },
  auth: { createPublicToken: mockCreatePublicToken },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  AGENT_APPROVAL_PROTOCOL_VERSION: 2,
  AGENT_APPROVAL_TOKEN_EXPIRATION: "1m",
  clearTemporaryAgentApprovalRefreshCookie: mockClearTemporaryRefreshCookie,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
  getTemporaryAgentApprovalRefreshHandle: mockGetTemporaryRefreshHandle,
  setTemporaryAgentApprovalRefreshCookie: mockSetTemporaryRefreshCookie,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

const requestFor = (chatId: string) =>
  ({
    headers: { get: () => null },
    nextUrl: new URL(`https://hackerai.co/api/agent/resume?chatId=${chatId}`),
  }) as any;

describe("agent resume route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({ userId: "user-1" } as never);
    mockGetChatById.mockResolvedValue(null as never);
    mockGetTemporaryRefreshHandle.mockReturnValue({
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    mockRunsRetrieve.mockResolvedValue({ status: "EXECUTING" } as never);
    mockCreatePublicToken
      .mockResolvedValueOnce("fresh-run-token" as never)
      .mockResolvedValueOnce("fresh-approval-token" as never);
  });

  it("refreshes temporary approval tokens from the signed mapping", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    const req = requestFor("temporary-chat-1");
    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      req,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId: "run-1",
      publicAccessToken: "fresh-run-token",
      chatId: "temporary-chat-1",
      approvalProtocolVersion: 2,
      approvalSessionId: "approval-session-1",
      approvalSessionPublicAccessToken: "fresh-approval-token",
    });
    expect(mockCreatePublicToken).toHaveBeenNthCalledWith(2, {
      scopes: { write: { sessions: "approval-session-1" } },
      expirationTime: "1m",
    });
    expect(mockSetTemporaryRefreshCookie).toHaveBeenCalledWith(response, {
      req,
      userId: "user-1",
      chatId: "temporary-chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    expect(mockSetActiveTriggerRun).not.toHaveBeenCalled();
  });

  it("rejects a temporary refresh without a valid mapping", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockGetTemporaryRefreshHandle.mockReturnValue(null);

    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      requestFor("temporary-chat-1"),
    );

    expect(response.status).toBe(403);
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
    expect(mockCreatePublicToken).not.toHaveBeenCalled();
  });

  it("clears the temporary mapping when the run is terminal", async () => {
    const { createAgentResumeGet } = await import("../agent-resume-route");
    mockRunsRetrieve.mockResolvedValue({ status: "COMPLETED" } as never);

    const req = requestFor("temporary-chat-1");
    const response = await createAgentResumeGet({ endpoint: "/api/agent" })(
      req,
    );

    expect(response.status).toBe(204);
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-terminal",
    );
    expect(mockClearTemporaryRefreshCookie).toHaveBeenCalledWith(response, {
      req,
      userId: "user-1",
      chatId: "temporary-chat-1",
    });
    expect(mockCreatePublicToken).not.toHaveBeenCalled();
  });
});
