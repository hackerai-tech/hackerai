jest.mock("@/lib/engagement-scope/admission", () => ({
  recordUserScope: jest.fn().mockResolvedValue(undefined),
}));
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
const mockGetUserIDAndPro = jest.fn<any>();
const mockGetFeatureFlagResult = jest.fn<any>();
const mockTriggerTask = jest.fn<any>();

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: mockGetUserIDAndPro,
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest
    .fn<any>()
    .mockResolvedValue(undefined),
}));
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlagResult: mockGetFeatureFlagResult,
    capture: jest.fn(),
    flush: jest.fn<any>().mockResolvedValue(undefined),
  }),
}));

jest.mock("next/server", () => ({
  after: jest.fn(),
  NextRequest: class NextRequest {},
  NextResponse: MockResponse,
}));

jest.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: mockCreatePublicToken },
  idempotencyKeys: { create: jest.fn() },
  sessions: { start: jest.fn() },
  tasks: { trigger: mockTriggerTask },
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
  getAgentApprovalDeploymentPin,
  getAgentTriggerPayloadSizeBytes,
  getAgentTriggerMachine,
  isAgentTriggerPayloadSizeTooLarge,
  isAgentTriggerRequestSizeTooLarge,
  isTriggerRequestBodyTooLargeError,
  shouldRequireAgentApprovalDeploymentPin,
} =
  require("../agent-trigger-route") as typeof import("../agent-trigger-route");

describe("web request correlation at Agent dispatch", () => {
  const { idempotencyKeys, sessions } = require("@trigger.dev/sdk");
  const { getChatById, getUserCustomization } = require("@/lib/db/actions");
  const {
    stripLocalDesktopSourcePaths,
  } = require("@/lib/utils/sandbox-file-utils");
  const previousSecret = process.env.AGENT_RUN_CORRELATION_SECRET;
  const requestId = "iad1::iad1-1792071667623-a1bd20d0daef";
  const retryRequestId = "iad1::iad1-1792071667624-b1bd20d0daef";
  const dispatchPaths = [
    ["/api/agent", "full_access"],
    ["/api/agent-long", "full_access"],
    ["/api/agent", "ask_approval"],
    ["/api/agent-long", "auto_review"],
  ] as const;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_RUN_CORRELATION_SECRET = "test-only-correlation-secret";
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user-1",
      subscription: "pro",
    });
    getChatById.mockResolvedValue(null);
    getUserCustomization.mockResolvedValue(null);
    stripLocalDesktopSourcePaths.mockImplementation(
      (messages: unknown) => messages,
    );
    idempotencyKeys.create.mockImplementation(async (parts: string[]) =>
      parts.join(":"),
    );
    mockTriggerTask.mockResolvedValue({ id: "run-existing" });
    sessions.start.mockResolvedValue({ runId: "run-existing", isCached: true });
    mockSetActiveTriggerRun.mockResolvedValue("updated");
    mockCreatePublicToken.mockReset().mockResolvedValue("test-token");
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined)
      delete process.env.AGENT_RUN_CORRELATION_SECRET;
    else process.env.AGENT_RUN_CORRELATION_SECRET = previousSecret;
  });

  const start = (
    endpoint: "/api/agent" | "/api/agent-long",
    agentPermissionMode: string,
    header?: string,
  ) =>
    createAgentTriggerPost({ endpoint })({
      headers: new Headers(
        header === undefined ? {} : { "x-vercel-id": header },
      ),
      json: async () => ({
        chatId: "chat-1",
        agentPermissionMode,
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "private-prompt-canary" }],
          },
        ],
        webRequestId: "untrusted-body-canary",
      }),
    } as any);

  it.each(dispatchPaths)(
    "correlates %s %s without changing retry identity or payload",
    async (endpoint, mode) => {
      const first = await start(endpoint, mode, requestId);
      const retry = await start(endpoint, mode, retryRequestId);
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(await first.json()).toMatchObject({ runId: "run-existing" });
      expect(await retry.json()).toMatchObject({ runId: "run-existing" });

      const approval = mode !== "full_access";
      const calls = approval
        ? sessions.start.mock.calls
        : mockTriggerTask.mock.calls;
      const firstMetadata = approval
        ? calls[0][0].metadata
        : calls[0][2].metadata;
      const retryMetadata = approval
        ? calls[1][0].metadata
        : calls[1][2].metadata;
      expect(firstMetadata).toMatchObject({
        webRequestId: requestId,
        endpoint,
      });
      expect(retryMetadata.webRequestId).toBe(retryRequestId);
      expect(JSON.stringify(firstMetadata)).not.toMatch(
        /private-prompt-canary|untrusted-body-canary/,
      );
      const payload = approval
        ? calls[0][0].triggerConfig.basePayload
        : calls[0][1];
      expect(payload).not.toHaveProperty("webRequestId");
      expect(idempotencyKeys.create.mock.calls).toEqual([
        [
          ["agent-run", "user-1", "chat-1", "send", "message-1"],
          { scope: "global" },
        ],
        [
          ["agent-run", "user-1", "chat-1", "send", "message-1"],
          { scope: "global" },
        ],
      ]);
      if (approval) {
        expect(calls[0][0].externalId).toBe(calls[1][0].externalId);
        expect(mockTriggerTask).not.toHaveBeenCalled();
      } else {
        expect(calls[0][2].idempotencyKey).toBe(calls[1][2].idempotencyKey);
        expect(calls[1][2].idempotencyKeyTTL).toBe("6h");
        expect(sessions.start).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    undefined,
    "",
    "private-target-canary",
    `${requestId}?private-target-canary`,
    "a".repeat(129),
  ])(
    "omits a missing or unsafe request header (%s) from task and session metadata",
    async (header) => {
      for (const [endpoint, mode] of dispatchPaths) {
        expect((await start(endpoint, mode, header)).status).toBe(200);
      }
      const metadata = [
        ...mockTriggerTask.mock.calls.map((call: any[]) => call[2].metadata),
        ...sessions.start.mock.calls.map((call: any[]) => call[0].metadata),
      ];
      expect(metadata).toHaveLength(dispatchPaths.length);
      for (const item of metadata)
        expect(item).not.toHaveProperty("webRequestId");
      expect(JSON.stringify(metadata)).not.toMatch(
        /private-target-canary|untrusted-body-canary/,
      );
    },
  );
});

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

  it("logs the slow startup stage without request content and clears its timer on failure", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let resolveBody!: (body: unknown) => void;
      const body = new Promise((resolve) => {
        resolveBody = resolve;
      });
      const post = createAgentTriggerPost({ endpoint: "/api/agent" });
      const response = post({
        headers: new Headers({ "x-vercel-id": "synthetic-request-id" }),
        json: () => body,
      } as any);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
        event: "agent_start_slow_request",
        endpoint: "/api/agent",
        request_id: "synthetic-request-id",
        stage: "parse_request",
        elapsed_ms: 10_000,
      });
      resolveBody({
        chatId: "chat-1",
        messages: [{ role: "user", content: "private request content" }],
        temporary: true,
      });
      expect((await response).status).toBe(400);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).not.toContain("private request content");
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
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

  it("requires an approval deployment pin only for production deployments", () => {
    expect(
      shouldRequireAgentApprovalDeploymentPin({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }),
    ).toBe(true);
    expect(
      shouldRequireAgentApprovalDeploymentPin({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(false);
    expect(
      shouldRequireAgentApprovalDeploymentPin({ NODE_ENV: "production" }),
    ).toBe(true);
    expect(
      shouldRequireAgentApprovalDeploymentPin({ NODE_ENV: "development" }),
    ).toBe(false);
  });

  it("pins approval sessions to the app commit without a legacy version", () => {
    expect(
      getAgentApprovalDeploymentPin({
        TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: " TRUE ",
        VERCEL_GIT_COMMIT_SHA: " commit-a ",
      }),
    ).toEqual({ externalDeploymentId: "commit-a" });
  });

  it("keeps the legacy version authoritative during the migration", () => {
    expect(
      getAgentApprovalDeploymentPin({
        TRIGGER_VERSION: " 20261013.1 ",
        TRIGGER_EXTERNAL_DEPLOYMENT_ID: "commit-a",
        TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
        VERCEL_GIT_COMMIT_SHA: "commit-b",
      }),
    ).toEqual({ lockToVersion: "20261013.1" });
  });

  it("accepts an explicit deployment id even when automatic discovery is off", () => {
    expect(
      getAgentApprovalDeploymentPin({
        TRIGGER_EXTERNAL_DEPLOYMENT_ID: " release-a ",
        TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "0",
        VERCEL_GIT_COMMIT_SHA: "commit-b",
      }),
    ).toEqual({ externalDeploymentId: "release-a" });
  });

  it.each([
    {},
    { VERCEL_GIT_COMMIT_SHA: "commit-a" },
    {
      TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "0",
      VERCEL_GIT_COMMIT_SHA: "commit-a",
    },
    {
      TRIGGER_EXTERNAL_DEPLOYMENT_ID: " ",
      TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
      VERCEL_GIT_COMMIT_SHA: " ",
    },
    { TRIGGER_EXTERNAL_DEPLOYMENT_ID: "a".repeat(129) },
  ])("does not invent a pin when deployment identity is unavailable", (env) => {
    expect(getAgentApprovalDeploymentPin(env)).toEqual({});
  });

  it("isolates approval session identities across app releases", () => {
    const input = {
      chatId: "chat-1",
      keyParts: ["agent-run", "user-1", "chat-1", "send", "message-1"],
      approvalProtocolVersion: 2,
      approvalWorkerVersion: undefined,
    };
    const first = buildAgentApprovalSessionId({
      ...input,
      approvalExternalDeploymentId: "commit-a",
    });
    expect(
      buildAgentApprovalSessionId({
        ...input,
        approvalExternalDeploymentId: "commit-a",
      }),
    ).toBe(first);
    expect(
      buildAgentApprovalSessionId({
        ...input,
        approvalExternalDeploymentId: "commit-b",
      }),
    ).not.toBe(first);
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

describe("regional subscription gate before Agent dispatch", () => {
  const previousVercel = process.env.VERCEL;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERCEL = "1";
    mockGetFeatureFlagResult.mockResolvedValue({
      key: "regional_subscription_first_v1",
      enabled: true,
      variant: "test",
      payload: undefined,
    });
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user-free",
      subscription: "free",
    });
  });
  afterEach(() => {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });
  it.each(["/api/agent", "/api/agent-long"] as const)(
    "blocks %s before chat persistence or paid worker dispatch",
    async (endpoint) => {
      const response = await createAgentTriggerPost({ endpoint })({
        headers: new Headers({ "x-vercel-ip-country": "NG" }),
        cookies: { get: () => undefined },
        json: async () => ({
          chatId: "test-chat",
          messages: [
            {
              id: "message-1",
              role: "user",
              parts: [{ type: "text", text: "Explain HTTP headers." }],
            },
          ],
          sandboxPreference: "local",
          regionalSubscriptionCountry: "US",
          subscription: "pro",
        }),
      } as any);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        metadata: { subscription_required: true },
      });
      expect(mockHandleInitialChatAndUserMessage).not.toHaveBeenCalled();
      expect(mockTriggerTask).not.toHaveBeenCalled();
    },
  );
});
