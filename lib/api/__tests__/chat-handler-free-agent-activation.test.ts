/**
 * @jest-environment node
 *
 * Runs the real chat handler admission path with the real activation
 * evaluator. External I/O (auth, Convex, Redis, PostHog) is mocked at its
 * boundary; a sentinel failure in the first Convex read stops admitted
 * requests before model work.
 */
import { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
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
  }),
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
jest.mock("@/lib/db/actions", () => ({
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

const send = (mode: "ask" | "agent" = "ask") =>
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
        chatId: "11111111-1111-4111-8111-111111111111",
        messages: [
          {
            id: "user-message-1",
            role: "user",
            parts: [{ type: "text", text: "synthetic prompt" }],
          },
        ],
        sandboxPreference: mode === "agent" ? "desktop" : undefined,
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
