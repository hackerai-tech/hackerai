import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreatePublicToken = jest.fn<any>();
const mockSetActiveTriggerRun = jest.fn<any>();
const mockCancelAgentTriggerRun = jest.fn<any>();
const mockCloseAgentApprovalSession = jest.fn<any>();

jest.mock("next/server", () => ({
  NextRequest: class NextRequest {},
  NextResponse: class NextResponse {},
}));

jest.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: mockCreatePublicToken },
  idempotencyKeys: { create: jest.fn() },
  sessions: { start: jest.fn() },
  tasks: { trigger: jest.fn() },
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: jest.fn(),
  getUserCustomization: jest.fn(),
  handleInitialChatAndUserMessage: jest.fn(),
  setActiveTriggerRun: mockSetActiveTriggerRun,
}));

jest.mock("@/lib/api/agent-approval-session", () => ({
  AGENT_APPROVAL_PROTOCOL_VERSION: 2,
  AGENT_APPROVAL_TOKEN_EXPIRATION: "15m",
  cancelAgentTriggerRun: mockCancelAgentTriggerRun,
  closeAgentApprovalSession: mockCloseAgentApprovalSession,
  setTemporaryAgentApprovalRefreshCookie: jest.fn(),
}));

jest.mock("@/lib/ai/tools/utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: class HybridSandboxManager {},
}));

jest.mock("@/lib/ai/tools/utils/sandbox-fallback", () => ({
  assertLocalSandboxFallbackAllowed: jest.fn(),
  getSandboxWithFallbackGuard: jest.fn(),
}));

jest.mock("@/lib/utils/sandbox-file-utils", () => ({
  getUploadBasePath: jest.fn(),
  hasLocalDesktopSourcePaths: jest.fn(),
  prepareLocalDesktopAttachmentsForTrigger: jest.fn(),
  rewriteSandboxFilePathsInMessages: jest.fn(),
  stripLocalDesktopSourcePaths: jest.fn(),
  uploadSandboxFiles: jest.fn(),
}));

const {
  buildAgentApprovalSessionId,
  buildAgentRunDedupeKeyParts,
  finalizeStartedAgentRun,
} =
  require("../agent-trigger-route") as typeof import("../agent-trigger-route");

describe("Agent trigger route lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePublicToken
      .mockResolvedValueOnce("run-token")
      .mockResolvedValueOnce("session-token");
    mockCancelAgentTriggerRun.mockResolvedValue(true);
    mockCloseAgentApprovalSession.mockResolvedValue(true);
  });

  it("closes and cancels a run that cannot be associated after deletion", async () => {
    mockSetActiveTriggerRun.mockResolvedValue("deleting");

    await expect(
      finalizeStartedAgentRun({
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
        temporary: false,
      }),
    ).rejects.toMatchObject({
      type: "not_found",
      surface: "chat",
      metadata: { agent_run_association: "deleting" },
    });

    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-association-failed",
    );
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
  });

  it("cleans up when the association mutation throws", async () => {
    const associationError = new Error("Convex unavailable");
    mockSetActiveTriggerRun
      .mockRejectedValueOnce(associationError)
      .mockResolvedValueOnce("stale");

    await expect(
      finalizeStartedAgentRun({
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
        temporary: false,
      }),
    ).rejects.toBe(associationError);

    expect(mockCloseAgentApprovalSession).toHaveBeenCalledTimes(1);
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
  });

  it("returns tokens only after the active run association succeeds", async () => {
    mockSetActiveTriggerRun.mockResolvedValue("updated");

    await expect(
      finalizeStartedAgentRun({
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
        temporary: false,
      }),
    ).resolves.toEqual({
      publicAccessToken: "run-token",
      approvalSessionPublicAccessToken: "session-token",
    });

    expect(mockCancelAgentTriggerRun).not.toHaveBeenCalled();
    expect(mockCloseAgentApprovalSession).not.toHaveBeenCalled();
  });

  it("clears an association when token creation fails after the run starts", async () => {
    mockCreatePublicToken.mockReset();
    mockCreatePublicToken
      .mockRejectedValueOnce(new Error("Token service unavailable"))
      .mockResolvedValueOnce("session-token");
    mockSetActiveTriggerRun.mockResolvedValue("updated");

    await expect(
      finalizeStartedAgentRun({
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
        temporary: false,
      }),
    ).rejects.toThrow("Token service unavailable");

    expect(mockSetActiveTriggerRun).toHaveBeenCalledWith({
      chatId: "chat-1",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      clearApprovalPending: true,
    });
    expect(mockCancelAgentTriggerRun).toHaveBeenCalledWith("run-1");
    expect(mockCloseAgentApprovalSession).toHaveBeenCalledWith(
      "approval-session-1",
      "agent-run-association-failed",
    );
  });

  it("changes Session external identity with protocol or worker version", () => {
    const input = {
      chatId: "chat-1",
      keyParts: ["agent-run", "user-1", "chat-1", "send", "message-1"],
    };
    const v2WorkerA = buildAgentApprovalSessionId({
      ...input,
      approvalProtocolVersion: 2,
      approvalWorkerVersion: "20260712.1",
    });

    expect(
      buildAgentApprovalSessionId({
        ...input,
        approvalProtocolVersion: 1,
        approvalWorkerVersion: "20260712.1",
      }),
    ).not.toBe(v2WorkerA);
    expect(
      buildAgentApprovalSessionId({
        ...input,
        approvalProtocolVersion: 2,
        approvalWorkerVersion: "20260712.2",
      }),
    ).not.toBe(v2WorkerA);
    expect(v2WorkerA).toMatch(/^agent-approval:v2:chat-1:/);
  });

  it("uses a new Session identity for each regeneration attempt", () => {
    const input = {
      userId: "user-1",
      chatId: "chat-1",
      requestMessages: [],
      regenerate: true,
      existingChatUpdateTime: 123,
      triggerRequestedAt: 456,
    };
    const firstAttempt = buildAgentRunDedupeKeyParts({
      ...input,
      agentRunRequestId: "attempt-1",
    });
    const retryOfFirstAttempt = buildAgentRunDedupeKeyParts({
      ...input,
      agentRunRequestId: "attempt-1",
    });
    const secondAttempt = buildAgentRunDedupeKeyParts({
      ...input,
      agentRunRequestId: "attempt-2",
    });

    expect(retryOfFirstAttempt).toEqual(firstAttempt);
    expect(secondAttempt).not.toEqual(firstAttempt);
  });
});
