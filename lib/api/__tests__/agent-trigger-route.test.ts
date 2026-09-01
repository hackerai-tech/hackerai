import { beforeEach, describe, expect, it, jest } from "@jest/globals";

class MockResponse {
  readonly status: number;
  private readonly body: unknown;

  constructor(body: unknown, init?: { status?: number }) {
    this.body = body;
    this.status = init?.status ?? 200;
  }

  static json(body: unknown, init?: { status?: number }) {
    return new MockResponse(body, init);
  }

  async json() {
    return this.body;
  }
}

Object.defineProperty(globalThis, "Response", {
  configurable: true,
  value: MockResponse,
});

const mockCreatePublicToken = jest.fn<any>();
const mockSetActiveTriggerRun = jest.fn<any>();
const mockHandleInitialChatAndUserMessage = jest.fn<any>();
const mockCancelAgentTriggerRun = jest.fn<any>();
const mockCloseAgentApprovalSession = jest.fn<any>();

jest.mock("next/server", () => ({
  after: jest.fn(),
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
  handleInitialChatAndUserMessage: mockHandleInitialChatAndUserMessage,
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
  AGENT_APPROVAL_TRIGGER_TAG_LIMIT,
  AGENT_TRIGGER_PAYLOAD_MAX_BYTES,
  buildAgentApprovalSessionId,
  buildAgentPermissionRunSnapshot,
  buildAgentRunDedupeKeyParts,
  createAgentTriggerPayloadTooLargeResponse,
  createAgentTriggerPost,
  finalizeStartedAgentRun,
  getAgentApprovalTriggerTags,
  getAgentTriggerPayloadSizeBytes,
  getAgentTriggerMachine,
  isAgentTriggerPayloadSizeTooLarge,
  isAgentTriggerRequestSizeTooLarge,
  isTriggerRequestBodyTooLargeError,
  shouldRequireAgentApprovalWorkerVersion,
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

  it("measures the aggregate serialized trigger payload in UTF-8 bytes", () => {
    const payload = { messages: [{ text: "security évidence" }] };

    expect(getAgentTriggerPayloadSizeBytes(payload)).toBe(
      Buffer.byteLength(JSON.stringify(payload), "utf8"),
    );
    expect(AGENT_TRIGGER_PAYLOAD_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(
      isAgentTriggerPayloadSizeTooLarge(AGENT_TRIGGER_PAYLOAD_MAX_BYTES),
    ).toBe(false);
    expect(
      isAgentTriggerPayloadSizeTooLarge(AGENT_TRIGGER_PAYLOAD_MAX_BYTES + 1),
    ).toBe(true);
  });

  it("rejects an oversized approval request when its base payload fits", () => {
    const basePayloadBytes = AGENT_TRIGGER_PAYLOAD_MAX_BYTES;
    const approvalRequestBodyBytes = AGENT_TRIGGER_PAYLOAD_MAX_BYTES + 1;

    expect(isAgentTriggerPayloadSizeTooLarge(basePayloadBytes)).toBe(false);
    expect(
      isAgentTriggerRequestSizeTooLarge({
        payloadBytes: basePayloadBytes,
        requestBodyBytes: approvalRequestBodyBytes,
      }),
    ).toBe(true);
  });

  it("recognizes only Trigger's exact request-body 413", () => {
    const bodyTooLarge = Object.assign(new Error("Request body too large"), {
      name: "TriggerApiError",
      status: 413,
    });

    expect(isTriggerRequestBodyTooLargeError(bodyTooLarge)).toBe(true);
    expect(
      isTriggerRequestBodyTooLargeError(
        Object.assign(new Error("Request body too large"), {
          name: "TriggerApiError",
          status: 500,
        }),
      ),
    ).toBe(false);
    expect(
      isTriggerRequestBodyTooLargeError(
        Object.assign(new Error("Provider media is too large"), {
          name: "TriggerApiError",
          statusCode: 413,
        }),
      ),
    ).toBe(false);
    expect(
      isTriggerRequestBodyTooLargeError(
        Object.assign(new Error("Request body too large"), { status: 413 }),
      ),
    ).toBe(false);
  });

  it("returns a user-correctable 413 for oversized Agent starts", async () => {
    const response = createAgentTriggerPayloadTooLargeResponse();

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "bad_request:api",
      cause: expect.stringContaining("too large to start"),
    });
  });

  it.each([true, false])(
    "rejects retired temporary=%s before persistence",
    async (temporary) => {
      const post = createAgentTriggerPost({ endpoint: "/api/agent" });
      const response = await post({
        headers: new Headers(),
        json: jest.fn().mockResolvedValue({
          chatId: "chat-1",
          messages: [],
          temporary,
        }),
      } as any);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "bad_request:api",
        cause: "Invalid chat request: temporary is no longer supported.",
        metadata: {
          invalid_request_field: "temporary",
          invalid_request_field_reason: "retired_field",
        },
      });
      expect(mockHandleInitialChatAndUserMessage).not.toHaveBeenCalled();
    },
  );

  it("closes and cancels a run that cannot be associated after deletion", async () => {
    mockSetActiveTriggerRun.mockResolvedValue("deleting");

    await expect(
      finalizeStartedAgentRun({
        chatId: "chat-1",
        runId: "run-1",
        approvalSessionId: "approval-session-1",
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

  it("requires an approval worker pin only for production deployments", () => {
    expect(
      shouldRequireAgentApprovalWorkerVersion({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }),
    ).toBe(true);
    expect(
      shouldRequireAgentApprovalWorkerVersion({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(false);
    expect(
      shouldRequireAgentApprovalWorkerVersion({ NODE_ENV: "production" }),
    ).toBe(true);
    expect(
      shouldRequireAgentApprovalWorkerVersion({ NODE_ENV: "development" }),
    ).toBe(false);
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

  it("snapshots each permission-mode transition for the next run", () => {
    const autoReviewRun = buildAgentPermissionRunSnapshot("auto_review");
    const askRun = buildAgentPermissionRunSnapshot("ask_approval");
    const fullAccessRun = buildAgentPermissionRunSnapshot("full_access");

    expect(autoReviewRun).toEqual({
      mode: "auto_review",
      triggerTag: "permission_auto_review",
      requiresApprovalSession: true,
    });
    expect(askRun).toEqual({
      mode: "ask_approval",
      triggerTag: "permission_ask_approval",
      requiresApprovalSession: true,
    });
    expect(fullAccessRun).toEqual({
      mode: "full_access",
      triggerTag: "permission_full_access",
      requiresApprovalSession: false,
    });
    expect(autoReviewRun.mode).toBe("auto_review");
  });

  it("caps approval trigger tags while preserving ordered run identifiers", () => {
    const triggerTags = [
      "user_user-1",
      "chat_chat-1",
      "sub_pro",
      "permission_auto_review",
      "future_tag_1",
      "future_tag_2",
    ];

    expect(getAgentApprovalTriggerTags(triggerTags)).toEqual(
      triggerTags.slice(0, AGENT_APPROVAL_TRIGGER_TAG_LIMIT),
    );
    expect(getAgentApprovalTriggerTags(triggerTags)).toHaveLength(5);
  });

  it.each([
    ["free", "small-1x"],
    ["pro", "small-2x"],
    ["pro-plus", "small-2x"],
    ["ultra", "small-2x"],
    ["team", "small-2x"],
  ] as const)("uses %s Agent runs on %s", (subscription, machine) => {
    expect(getAgentTriggerMachine(subscription)).toBe(machine);
  });
});
