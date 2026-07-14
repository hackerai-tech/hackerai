import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetUserIDAndPro = jest.fn();
const mockGetChatById = jest.fn();
const mockGetTemporaryRefreshHandle = jest.fn();
const mockSetTemporaryRefreshCookie = jest.fn();
const mockClearTemporaryRefreshCookie = jest.fn();
const mockRunsRetrieve = jest.fn();
const mockSessionsRetrieve = jest.fn();
const mockSessionSend = jest.fn();
const mockSignApprovalInput = jest.fn((input: any) => ({
  ...input,
  authorization: { ...input.authorization, signature: "signed" },
}));
const mockListOrganizationMemberships = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    private body: unknown;
    cookies = { set: jest.fn(), delete: jest.fn() };

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
  runs: { retrieve: mockRunsRetrieve },
  sessions: {
    retrieve: mockSessionsRetrieve,
    open: jest.fn(() => ({ in: { send: mockSessionSend } })),
  },
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
}));

jest.mock("@/lib/chat/agent-approval-authorization", () => ({
  signAgentToolApprovalInput: mockSignApprovalInput,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  AGENT_APPROVAL_PROTOCOL_VERSION: 2,
  clearTemporaryAgentApprovalRefreshCookie: mockClearTemporaryRefreshCookie,
  getTemporaryAgentApprovalRefreshHandle: mockGetTemporaryRefreshHandle,
  setTemporaryAgentApprovalRefreshCookie: mockSetTemporaryRefreshCookie,
}));

jest.mock("@/lib/api/agent-route-errors", () => ({
  handleAgentRouteError: jest.fn(() => {
    throw new Error("unexpected route error");
  }),
}));

const decision = {
  type: "agent-tool-approval",
  approvalId: "approval-1",
  toolCallId: "tool-call-1",
  decision: "approve",
  grant: "full_access",
  at: 123,
};

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    json: jest.fn(async () => ({
      chatId: "chat-1",
      approvalSessionId: "approval-session-1",
      partId: "approval-part-1",
      value: decision,
      ...overrides,
    })),
  }) as any;

const run = (overrides: Record<string, unknown> = {}) => ({
  status: "EXECUTING",
  metadata: {
    userId: "user-1",
    chatId: "chat-1",
    approvalSessionId: "approval-session-1",
    approvalProtocolVersion: 2,
    approvalStatus: "pending",
    approvalId: "approval-1",
    approvalToolCallId: "tool-call-1",
  },
  ...overrides,
});

describe("agent approval route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "pro",
    } as never);
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
      active_trigger_run_id: "run-1",
      active_agent_approval_session_id: "approval-session-1",
      active_agent_approval_request: {
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
      },
    } as never);
    mockRunsRetrieve.mockResolvedValue(run() as never);
    mockSessionsRetrieve.mockResolvedValue({
      currentRunId: "run-1",
      closedAt: null,
    } as never);
    mockSessionSend.mockResolvedValue(undefined as never);
    mockListOrganizationMemberships.mockResolvedValue({ data: [{}] } as never);
  });

  it("signs current identity and appends only the signed record server-side", async () => {
    const { createAgentApprovalPost } = await import("../agent-approval-route");
    const now = jest.spyOn(Date, "now").mockReturnValue(456);

    const response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      request(),
    );

    expect(response.status).toBe(200);
    expect(mockSignApprovalInput).toHaveBeenCalledWith({
      ...decision,
      protocolVersion: 2,
      authorization: {
        issuedAt: 456,
        userId: "user-1",
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
        subscription: "pro",
      },
    });
    expect(mockSessionSend).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 2,
        authorization: expect.objectContaining({ signature: "signed" }),
      }),
      { additionalHeaders: { "X-Part-Id": "approval-part-1" } },
    );
    now.mockRestore();
  });

  it("rejects a persisted pending approval mismatch before signing", async () => {
    const { createAgentApprovalPost } = await import("../agent-approval-route");

    const response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      request({ value: { ...decision, toolCallId: "other-tool-call" } }),
    );

    expect(response.status).toBe(409);
    expect(mockRunsRetrieve).not.toHaveBeenCalled();
    expect(mockSignApprovalInput).not.toHaveBeenCalled();
    expect(mockSessionSend).not.toHaveBeenCalled();
  });

  it("uses bounded current metadata after arbitrarily long temporary output", async () => {
    const { createAgentApprovalPost } = await import("../agent-approval-route");
    mockGetChatById.mockResolvedValue(null as never);
    mockGetTemporaryRefreshHandle.mockReturnValue({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    const req = request();
    const response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      req,
    );

    expect(response.status).toBe(200);
    expect(mockSessionSend).toHaveBeenCalledTimes(1);
    expect(mockSetTemporaryRefreshCookie).toHaveBeenCalledWith(response, {
      req,
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
  });

  it("rejects a temporary approval that is no longer the current pending request", async () => {
    const { createAgentApprovalPost } = await import("../agent-approval-route");
    mockGetChatById.mockResolvedValue(null as never);
    mockGetTemporaryRefreshHandle.mockReturnValue({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      approvalSessionId: "approval-session-1",
    });
    mockRunsRetrieve.mockResolvedValue(
      run({
        metadata: {
          ...run().metadata,
          approvalStatus: "approve",
        },
      }) as never,
    );

    const req = request();
    const response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      req,
    );

    expect(response.status).toBe(409);
    expect(mockClearTemporaryRefreshCookie).toHaveBeenCalledWith(response, {
      req,
      userId: "user-1",
      chatId: "chat-1",
    });
    expect(mockSignApprovalInput).not.toHaveBeenCalled();
    expect(mockSessionSend).not.toHaveBeenCalled();
  });

  it("fails closed on protocol metadata or active org membership mismatch", async () => {
    const { createAgentApprovalPost } = await import("../agent-approval-route");
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "team",
      organizationId: "org-1",
    } as never);
    mockListOrganizationMemberships.mockResolvedValue({ data: [] } as never);

    let response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      request(),
    );
    expect(response.status).toBe(403);
    expect(mockRunsRetrieve).not.toHaveBeenCalled();

    mockListOrganizationMemberships.mockResolvedValue({ data: [{}] } as never);
    mockRunsRetrieve.mockResolvedValue(
      run({
        metadata: {
          ...run().metadata,
          approvalProtocolVersion: 1,
        },
      }) as never,
    );
    response = await createAgentApprovalPost({ endpoint: "/api/agent" })(
      request(),
    );
    expect(response.status).toBe(409);
    expect(mockSignApprovalInput).not.toHaveBeenCalled();
  });
});
