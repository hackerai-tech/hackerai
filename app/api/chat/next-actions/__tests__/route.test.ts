import { after, type NextRequest } from "next/server";
import { POST } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getConvexClient } from "@/lib/db/convex-client";
import { generateNextActions } from "@/lib/chat/next-actions/generate";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { enforceRegionalSubscriptionFirst } from "@/lib/experiments/regional-subscription-first.server";
const capture = jest.fn();
const shutdown = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ capture, shutdown }),
}));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));
jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: jest.fn(),
}));
jest.mock("@/lib/chat/next-actions/generate", () => ({
  generateNextActions: jest.fn(),
}));
jest.mock("@/lib/experiments/regional-subscription-first.server", () => ({
  enforceRegionalSubscriptionFirst: jest.fn(),
  subscriptionFirstCountryFromRequest: () => undefined,
}));
const query = jest.fn();
const reserve = jest.fn();
const chatId = "11111111-1111-4111-8111-111111111111";
let chat: Record<string, unknown>;
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));
const request = (body = { chatId, messageId: "answer" }) =>
  ({
    signal: new AbortController().signal,
    text: async () => JSON.stringify(body),
  }) as NextRequest;

beforeEach(() => {
  jest.clearAllMocks();
  shutdown.mockResolvedValue(undefined);
  chat = {
    user_id: "owner",
    finish_reason: "stop",
    last_run_finished_at: Date.now(),
    default_model_slug: "ask",
  };
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
  });
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  jest.mocked(getConvexClient).mockReturnValue({ query } as never);
  query.mockImplementation(async (_name, args) =>
    args.paginationOpts
      ? {
          page: [
            {
              id: "answer",
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: "Synthetic finding lacks impact evidence.",
                },
              ],
            },
            {
              id: "user",
              role: "user",
              parts: [
                { type: "text", text: "Explain this synthetic finding." },
              ],
            },
          ],
        }
      : chat,
  );
  jest.mocked(createRedisClient).mockReturnValue({ eval: reserve } as never);
  reserve.mockResolvedValue(1);
  jest.mocked(generateNextActions).mockResolvedValue({
    suggestions: ["Explain the missing impact evidence."],
    inputTokens: 100,
    outputTokens: 30,
    modelId: "deepseek/deepseek-v4.1-flash-1017",
    reasoningTokens: 0,
    cost: 0.0001,
  });
});

test("generates from owned bounded persisted context and emits no content in analytics", async () => {
  const result = await POST(request());
  expect((await result.json()).suggestions).toEqual([
    "Explain the missing impact evidence.",
  ]);
  expect(
    query.mock.calls.find(([, args]) => args.paginationOpts)?.[1].paginationOpts
      .numItems,
  ).toBe(6);
  expect(generateNextActions).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: "answer" })]),
    expect.any(AbortSignal),
  );
  expect(JSON.stringify(capture.mock.calls)).not.toMatch(
    /Synthetic finding|missing impact evidence/,
  );
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(enforceRegionalSubscriptionFirst).toHaveBeenCalledWith(
    expect.objectContaining({ surface: "ask", captureExposure: false }),
  );
});

test.each([
  "wrong owner",
  "active",
  "canceled",
  "error",
  "old",
  "flag off",
  "duplicate",
  "suspended",
  "stale message",
])("does not generate for %s", async (condition) => {
  if (condition === "wrong owner") chat.user_id = "someone-else";
  if (condition === "active") chat.active_trigger_run_id = "run";
  if (condition === "canceled") chat.canceled_at = Date.now();
  if (condition === "error") chat.finish_reason = "error";
  if (condition === "old") chat.last_run_finished_at = Date.now() - 3600_000;
  if (condition === "flag off")
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(false);
  if (condition === "duplicate") reserve.mockResolvedValue(0);
  if (condition === "suspended")
    jest
      .mocked(assertUserCanMakeCostIncurringRequest)
      .mockRejectedValueOnce(new Error("blocked"));
  const result = await POST(
    request({
      chatId,
      messageId: condition === "stale message" ? "old-answer" : "answer",
    }),
  );
  const expectedStatus: Record<string, number> = {
    "wrong owner": 404,
    active: 409,
    canceled: 409,
    error: 409,
    "stale message": 409,
  };
  if (expectedStatus[condition])
    expect(result.status).toBe(expectedStatus[condition]);
  expect((await result.json()).suggestions).toEqual([]);
  expect(generateNextActions).not.toHaveBeenCalled();
});

test("provider failure and a new run during generation suppress predictions", async () => {
  jest
    .mocked(generateNextActions)
    .mockRejectedValueOnce(new Error("private provider payload"));
  expect((await (await POST(request())).json()).suggestions).toEqual([]);
  jest.mocked(generateNextActions).mockImplementationOnce(async () => {
    chat = { ...chat, active_trigger_run_id: "new-run" };
    return {
      suggestions: ["Explain the evidence."],
      inputTokens: 1,
      outputTokens: 1,
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      reasoningTokens: 0,
      cost: 0,
    };
  });
  expect((await (await POST(request())).json()).suggestions).toEqual([]);
  expect(JSON.stringify(capture.mock.calls)).not.toContain(
    "private provider payload",
  );
});

test.each([
  { page: [] },
  { page: [{ id: "new-answer", role: "assistant" }] },
  { page: [{ id: "new-question", role: "user" }] },
])(
  "discards a prediction when the source message changes during generation: %j",
  async ({ page }) => {
    jest.mocked(generateNextActions).mockImplementationOnce(async () => {
      query.mockImplementation(async (_name, args) =>
        args.paginationOpts ? { page } : chat,
      );
      return {
        suggestions: ["Explain the evidence."],
        inputTokens: 1,
        outputTokens: 1,
        modelId: "deepseek/deepseek-v4.1-flash-1017",
        reasoningTokens: 0,
        cost: 0,
      };
    });
    expect((await (await POST(request())).json()).suggestions).toEqual([]);
  },
);

test("returns the draft before analytics shutdown and flushes after the response", async () => {
  let finishFlush!: () => void;
  shutdown.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishFlush = resolve;
    }),
  );
  const result = await POST(request());
  expect((await result.json()).suggestions).toHaveLength(1);
  expect(shutdown).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledTimes(1);
  const flush = jest.mocked(after).mock.calls[0][0] as () => Promise<void>;
  const flushing = flush();
  expect(shutdown).toHaveBeenCalledTimes(1);
  finishFlush();
  await flushing;
  expect(capture.mock.calls.map(([event]) => event.event)).toContain(
    "contextual_next_actions_generated",
  );
});

test("analytics flush failure after the response does not reject or lose the draft", async () => {
  shutdown.mockRejectedValueOnce(new Error("analytics unavailable"));
  const result = await POST(request());
  const flush = jest.mocked(after).mock.calls[0][0] as () => Promise<void>;
  await expect(flush()).resolves.toBeUndefined();
  expect((await result.json()).suggestions).toHaveLength(1);
});

test.each(["control", "test"])(
  "records eligible experiment assignment for %s without conflating it with visible exposure",
  async (variant) => {
    jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(variant);
    await POST(request());
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "contextual_next_actions_eligible",
        properties: expect.objectContaining({
          assignment: variant,
          "$feature/contextual-next-actions": variant,
          experiment_version: "next-actions-v1",
        }),
      }),
    );
    expect(assertUserCanMakeCostIncurringRequest).toHaveBeenCalledTimes(1);
    expect(enforceRegionalSubscriptionFirst).toHaveBeenCalledTimes(1);
    expect(generateNextActions).toHaveBeenCalledTimes(
      variant === "test" ? 1 : 0,
    );
    expect(
      capture.mock.calls.some(
        ([entry]) => entry.event === "contextual_next_actions_exposed",
      ),
    ).toBe(false);
  },
);

test("disabled flag does not enroll users as controls", async () => {
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(false);
  await POST(request());
  expect(capture).not.toHaveBeenCalled();
});

test("ineligible control users are not enrolled", async () => {
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("control");
  jest
    .mocked(assertUserCanMakeCostIncurringRequest)
    .mockRejectedValueOnce(new Error("suspended"));
  await POST(request());
  expect(capture).not.toHaveBeenCalled();
  expect(generateNextActions).not.toHaveBeenCalled();
});
