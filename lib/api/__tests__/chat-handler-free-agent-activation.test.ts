/**
 * @jest-environment node
 *
 * Runs the real chat handler admission path with the real activation
 * evaluator. External I/O (auth, Convex, Redis, PostHog) is mocked at its
 * boundary; a sentinel failure stops admitted requests before provider work
 * (the first Convex read, or the stream boundary for regeneration tests).
 */
import { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import { selectModel } from "@/lib/chat/chat-processor";
import { createChatHandler } from "../chat-handler";

const mockGetUserIDAndPro = jest.fn();
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: (...args: unknown[]) => mockGetUserIDAndPro(...args),
}));

jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(async () => undefined),
}));

const mockEnforceRegional = jest.fn();
jest.mock("@/lib/experiments/regional-subscription-first.server", () => ({
  enforceRegionalSubscriptionFirst: (...args: unknown[]) =>
    mockEnforceRegional(...args),
  subscriptionFirstCountryFromRequest: () => undefined,
}));

const mockGetFeatureFlagResult = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({
    getFeatureFlagResult: mockGetFeatureFlagResult,
    capture: jest.fn(),
    flush: jest.fn(),
    shutdown: jest.fn(),
  }),
}));
jest.mock("@/lib/api/chat-logger", () => ({
  ...jest.requireActual("@/lib/api/chat-logger"),
  shutdownPostHog: jest.fn(),
}));

const stored = new Map<string, number>();
jest.mock("@/lib/rate-limit/redis", () => ({
  ...jest.requireActual("@/lib/rate-limit/redis"),
  createRedisClient: () => ({
    scard: async (key: string) => stored.get(key) ?? 0,
    // First-assignment telemetry marker.
    eval: async () => 1_763_197_200_000,
  }),
}));

const callOrder: string[] = [];
const PROVIDER_NOT_STARTED = new Error("stopped at the provider boundary");
const mockProcessChatMessages = jest.fn();
jest.mock("@/lib/chat/chat-processor", () => ({
  ...jest.requireActual("@/lib/chat/chat-processor"),
  processChatMessages: (...args: unknown[]) => mockProcessChatMessages(...args),
}));
// The cancellation subscriber is created immediately before the provider
// stream; stopping here proves no provider work started.
const mockCreateCancellationSubscriber = jest.fn();
jest.mock("@/lib/utils/stream-cancellation", () => ({
  ...jest.requireActual("@/lib/utils/stream-cancellation"),
  createCancellationSubscriber: (...args: unknown[]) =>
    mockCreateCancellationSubscriber(...args),
}));

const mockReleaseLock = jest.fn(async () => undefined);
const mockAcquireLock = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockCheckFreeMonthlyCostLimit = jest.fn();
jest.mock("@/lib/rate-limit", () => ({
  ...jest.requireActual("@/lib/rate-limit"),
  acquireFreeRunConcurrencyLock: (...args: unknown[]) =>
    mockAcquireLock(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  checkFreeMonthlyCostLimit: (...args: unknown[]) =>
    mockCheckFreeMonthlyCostLimit(...args),
}));

const ADMITTED = new Error("admitted past activation gate");
const mockGetUserCustomization = jest.fn();
const mockGetMessagesByChatId = jest.fn();
const mockHandleInitialChat = jest.fn();
const mockDeleteRegenerateChain = jest.fn();
jest.mock("@/lib/db/actions", () => ({
  deleteFreeAskRegenerateChain: (...args: unknown[]) =>
    mockDeleteRegenerateChain(...args),
  getUserCustomization: (...args: unknown[]) =>
    mockGetUserCustomization(...args),
  getMessagesByChatId: (...args: unknown[]) => mockGetMessagesByChatId(...args),
  handleInitialChatAndUserMessage: (...args: unknown[]) =>
    mockHandleInitialChat(...args),
  getNotes: jest.fn(async () => []),
  prepareForNewStream: jest.fn(),
  saveMessage: jest.fn(),
  updateChat: jest.fn(),
  updateChatTitle: jest.fn(),
}));

const SUBJECT = "free_quota:v2:synthetic";
const STORAGE_KEY = `free_agent_activation:v1:${SUBJECT}`;
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const freeIdentity = {
  userId: "user_synthetic",
  subscription: "free",
  emailVerified: true,
  accountCreatedAt: "2026-11-15T09:00:00.000Z",
  freeUsageQuotaSubject: SUBJECT,
};

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const USER_MESSAGE = {
  id: "user-message-1",
  role: "user",
  parts: [{ type: "text", text: "synthetic prompt" }],
};

const send = (
  mode: "ask" | "agent" = "ask",
  extraBody: Record<string, unknown> = {},
) =>
  createChatHandler()(
    new NextRequest("https://app.example.test/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": DESKTOP_CHROME,
        "x-vercel-ip-country": "US",
      },
      body: JSON.stringify({
        mode,
        chatId: CHAT_ID,
        messages: [USER_MESSAGE],
        sandboxPreference: mode === "agent" ? "desktop" : undefined,
        ...extraBody,
      }),
    }),
  );

const expectNoQuotaOrModelWork = () => {
  expect(mockGetUserCustomization).not.toHaveBeenCalled();
  expect(mockGetMessagesByChatId).not.toHaveBeenCalled();
  expect(mockHandleInitialChat).not.toHaveBeenCalled();
  expect(mockCheckFreeMonthlyCostLimit).not.toHaveBeenCalled();
  expect(mockCheckRateLimit).not.toHaveBeenCalled();
};

describe("chat handler free Agent activation admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stored.clear();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    mockGetUserIDAndPro.mockResolvedValue(freeIdentity);
    mockEnforceRegional.mockResolvedValue(undefined);
    mockAcquireLock.mockResolvedValue({ release: mockReleaseLock });
    mockGetFeatureFlagResult.mockResolvedValue({
      key: "free_agent_activation_gate_v1",
      enabled: true,
      variant: "test",
      payload: { new_users_from: "2026-11-15T00:00:00.000Z" },
    });
    mockGetUserCustomization.mockRejectedValue(ADMITTED);
    mockGetMessagesByChatId.mockRejectedValue(ADMITTED);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("denies a fourth treatment Ask under the run lock before quota or model work", async () => {
    stored.set(STORAGE_KEY, 3);

    const response = await send();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "forbidden:chat",
      metadata: { free_agent_activation_required: true },
    });
    expect(mockAcquireLock).toHaveBeenCalledWith(SUBJECT, expect.any(Number));
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expectNoQuotaOrModelWork();
  });

  it("admits the third treatment Ask while fewer than three responses are saved", async () => {
    stored.set(STORAGE_KEY, 2);

    await send();

    expect(mockGetUserCustomization).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps the subscription-first country gate ahead of the activation gate", async () => {
    stored.set(STORAGE_KEY, 3);
    mockEnforceRegional.mockRejectedValue(
      new ChatSDKError("forbidden:chat", "Choose a subscription", {
        subscription_required: true,
      }),
    );

    const response = await send();

    await expect(response.json()).resolves.toMatchObject({
      metadata: { subscription_required: true },
    });
    expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("does not evaluate the experiment when the run lock is already held", async () => {
    stored.set(STORAGE_KEY, 3);
    mockAcquireLock.mockRejectedValue(
      new ChatSDKError("rate_limit:chat", "free request running", {
        capReason: "free_concurrency",
      }),
    );

    const response = await send();

    await expect(response.json()).resolves.toMatchObject({
      metadata: { capReason: "free_concurrency" },
    });
    expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a paid Ask request",
      { ...freeIdentity, subscription: "pro" },
      "ask",
      403,
      "Paid plans use Agent mode",
    ],
    [
      "an Agent request sent to the Ask route",
      freeIdentity,
      "agent",
      400,
      "Trigger.dev-backed",
    ],
  ] as const)(
    "keeps the existing response for %s without evaluating the experiment",
    async (_, identity, mode, status, cause) => {
      stored.set(STORAGE_KEY, 3);
      mockGetUserIDAndPro.mockResolvedValue(identity);

      const response = await send(mode);

      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.cause).toContain(cause);
      expect(body.metadata?.free_agent_activation_required).toBeUndefined();
      expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
    },
  );

  it("admits Ask under the kill switch while stored progress remains", async () => {
    stored.set(STORAGE_KEY, 3);
    mockGetFeatureFlagResult.mockResolvedValue({
      key: "free_agent_activation_gate_v1",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });

    await send();

    expect(mockGetUserCustomization).toHaveBeenCalled();
    expect(stored.get(STORAGE_KEY)).toBe(3);
  });
});

describe("deferred free Ask regeneration", () => {
  const todos = [{ id: "t1", content: "Retest", status: "pending" }];
  const regenerateBody = {
    regenerate: true,
    deferredRegenerateAssistantIds: ["assistant-old-1", "assistant-old-2"],
    todos,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    stored.clear();
    callOrder.length = 0;
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetUserIDAndPro.mockResolvedValue(freeIdentity);
    mockEnforceRegional.mockResolvedValue(undefined);
    mockAcquireLock.mockResolvedValue({ release: mockReleaseLock });
    // Only this experiment is assigned; other server experiments stay off.
    mockGetFeatureFlagResult.mockImplementation(async (key: string) =>
      key === "free_agent_activation_gate_v1"
        ? {
            key,
            enabled: true,
            variant: "test",
            payload: { new_users_from: "2026-11-15T00:00:00.000Z" },
          }
        : undefined,
    );
    mockGetUserCustomization.mockResolvedValue(null);
    mockGetMessagesByChatId.mockResolvedValue({
      chat: { id: CHAT_ID, user_id: freeIdentity.userId, todos: [] },
      isNewChat: false,
      fileTokens: {},
      truncatedMessages: [USER_MESSAGE],
    });
    mockHandleInitialChat.mockResolvedValue(undefined);
    mockCheckFreeMonthlyCostLimit.mockResolvedValue(null);
    mockCheckRateLimit.mockImplementation(async () => {
      callOrder.push("quota");
      return { remaining: 9, pointsDeducted: 0 };
    });
    mockDeleteRegenerateChain.mockImplementation(async () => {
      callOrder.push("delete_chain");
    });
    mockProcessChatMessages.mockImplementation(async () => {
      callOrder.push("model_preparation");
      return {
        processedMessages: [USER_MESSAGE],
        selectedModel: selectModel("ask", "free"),
        sandboxFiles: [],
        platformAuthorized: false,
        moderationChecked: false,
        allowsFreeAbliteration: false,
      };
    });
    mockCreateCancellationSubscriber.mockImplementation(async () => {
      callOrder.push("provider_boundary");
      throw PROVIDER_NOT_STARTED;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("deletes the exact replaced chain only after every admission and preflight check, before the provider", async () => {
    stored.set(STORAGE_KEY, 2);

    await send("ask", regenerateBody);

    expect(mockDeleteRegenerateChain).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      userId: freeIdentity.userId,
      expectedAssistantIds: ["assistant-old-1", "assistant-old-2"],
      todos,
    });
    expect(callOrder).toEqual([
      "quota",
      "model_preparation",
      "delete_chain",
      "provider_boundary",
    ]);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps the old answer when a later preflight check refuses the request", async () => {
    mockProcessChatMessages.mockImplementation(async () => {
      callOrder.push("model_preparation");
      throw new ChatSDKError("bad_request:api", "Message could not be used");
    });

    const response = await send("ask", regenerateBody);

    expect(response.status).toBe(400);
    expect(mockDeleteRegenerateChain).not.toHaveBeenCalled();
    expect(mockCreateCancellationSubscriber).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["the activation gate refuses", () => stored.set(STORAGE_KEY, 3)],
    [
      "the subscription-first country gate refuses",
      () =>
        mockEnforceRegional.mockRejectedValue(
          new ChatSDKError("forbidden:chat", "Choose a subscription", {
            subscription_required: true,
          }),
        ),
    ],
    [
      "the daily quota refuses",
      () =>
        mockCheckRateLimit.mockRejectedValue(
          new ChatSDKError("rate_limit:chat", "Daily limit reached"),
        ),
    ],
  ])("never deletes the old answer when %s", async (_, arrange) => {
    arrange();

    const response = await send("ask", regenerateBody);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockDeleteRegenerateChain).not.toHaveBeenCalled();
    expect(mockCreateCancellationSubscriber).not.toHaveBeenCalled();
  });

  it("refuses a raced chain without starting the provider", async () => {
    mockDeleteRegenerateChain.mockRejectedValue(
      new ChatSDKError("bad_request:chat", "changed", {
        regenerate_chain_mismatch: true,
      }),
    );

    const response = await send("ask", regenerateBody);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      metadata: { regenerate_chain_mismatch: true },
    });
    expect(mockCreateCancellationSubscriber).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing regenerate behavior when the marker is absent", async () => {
    await send("ask", { regenerate: true, todos });

    expect(mockDeleteRegenerateChain).not.toHaveBeenCalled();
    expect(callOrder).toEqual([
      "quota",
      "model_preparation",
      "provider_boundary",
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a non-regeneration request",
      { deferredRegenerateAssistantIds: ["assistant-old-1"] },
    ],
    [
      "an empty chain",
      { regenerate: true, deferredRegenerateAssistantIds: [] },
    ],
    [
      "duplicate IDs",
      { regenerate: true, deferredRegenerateAssistantIds: ["a", "a"] },
    ],
    [
      "an oversized ID",
      {
        regenerate: true,
        deferredRegenerateAssistantIds: ["x".repeat(129)],
      },
    ],
    [
      "more than 256 IDs",
      {
        regenerate: true,
        deferredRegenerateAssistantIds: Array.from(
          { length: 257 },
          (_, i) => `a${i}`,
        ),
      },
    ],
  ])("rejects %s before authentication or deletion", async (_, body) => {
    const response = await send("ask", body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      metadata: { invalid_request_field: "deferredRegenerateAssistantIds" },
    });
    expect(mockGetUserIDAndPro).not.toHaveBeenCalled();
    expect(mockDeleteRegenerateChain).not.toHaveBeenCalled();
  });
});
