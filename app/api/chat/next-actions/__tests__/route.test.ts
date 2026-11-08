import { after, type NextRequest } from "next/server";
import { getFunctionName } from "convex/server";
import { POST, DELETE } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getConvexClient } from "@/lib/db/convex-client";
import { generateNextActions } from "@/lib/chat/next-actions/generate";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
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
const mutation = jest.fn();
let saved: unknown = null;
let predictionsEnabled = true;
let achievedElapsedMs: number | undefined;
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
    headers: new Headers({
      "x-vercel-id": "iad1::qa123-1794060000000-abcdef123456",
    }),
    text: async () => JSON.stringify(body),
  }) as NextRequest;

beforeEach(() => {
  jest.clearAllMocks();
  shutdown.mockResolvedValue(undefined);
  saved = null;
  predictionsEnabled = true;
  achievedElapsedMs = undefined;
  mutation.mockImplementation(async (_name, args) => args.batch ?? true);
  chat = {
    id: chatId,
    user_id: "owner",
    finish_reason: "stop",
    last_run_finished_at: Date.now(),
    default_model_slug: "ask",
  };
  jest.mocked(getUserIDAndPro).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
    emailVerified: true,
    analyticsAccountCohort: "non_internal",
  });
  jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(true);
  jest.mocked(getConvexClient).mockReturnValue({ query, mutation } as never);
  query.mockImplementation(async (_name, args) =>
    getFunctionName(_name) === "messages:getLastAssistantMessage"
      ? {
          id: "answer",
          role: "assistant",
          metadata: { goal: { achievedElapsedMs } },
        }
      : args.userId && !args.chatId
        ? { enabled: predictionsEnabled }
        : args.chatId && !args.paginationOpts
          ? saved
          : args.paginationOpts
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
    knownCost: 0.0001,
    providerCalls: 2,
    pricedProviderCalls: 2,
    unknownProviderCalls: 0,
    modelIds: ["deepseek/deepseek-v4.1-flash-1017"],
    unavailable: false,
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
  "waiting for reply",
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
  if (condition === "waiting for reply")
    chat.active_agent_user_wait = { runId: "run", toolCallId: "wait" };
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
    "waiting for reply": 409,
    canceled: 409,
    error: 409,
    "stale message": 409,
  };
  if (expectedStatus[condition])
    expect(result.status).toBe(expectedStatus[condition]);
  const reasons: Record<string, string> = {
    "wrong owner": "chat_unavailable",
    active: "source_active",
    "waiting for reply": "source_waiting",
    canceled: "source_canceled",
    error: "source_not_successful",
    old: "source_expired",
    "flag off": "not_offered",
    duplicate: "generation_reserved_or_budgeted",
    suspended: "server_error",
    "stale message": "source_stale",
  };
  expect(result.headers.get("X-HackerAI-Next-Actions-Reason")).toBe(
    reasons[condition],
  );
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
      knownCost: 0,
      providerCalls: 0,
      pricedProviderCalls: 0,
      unknownProviderCalls: 0,
      modelIds: [],
      unavailable: false,
    };
  });
  expect((await (await POST(request())).json()).suggestions).toEqual([]);
  expect(JSON.stringify(capture.mock.calls)).not.toContain(
    "private provider payload",
  );
});

test("unavailable reservation infrastructure is distinct from normal dedupe or budget gating", async () => {
  jest.mocked(createRedisClient).mockReturnValueOnce(null as never);
  const result = await POST(request());
  expect(result.status).toBe(200);
  expect(result.headers.get("X-HackerAI-Next-Actions-Reason")).toBe(
    "reservation_unavailable",
  );
  expect(generateNextActions).not.toHaveBeenCalled();
});

test.each(["unauthorized:auth", "forbidden:chat", "rate_limit:chat"] as const)(
  "typed %s denial is not attributed to a server defect",
  async (code) => {
    const error = new ChatSDKError(
      code,
      "private account or authorization details",
    );
    if (code === "unauthorized:auth")
      jest.mocked(getUserIDAndPro).mockRejectedValueOnce(error);
    else
      jest
        .mocked(assertUserCanMakeCostIncurringRequest)
        .mockRejectedValueOnce(error);
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("X-HackerAI-Next-Actions-Reason")).toBe(
      code === "unauthorized:auth" ? "auth_required" : "access_denied",
    );
    expect(JSON.stringify(await result.json())).toBe('{"suggestions":[]}');
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private account");
    expect(generateNextActions).not.toHaveBeenCalled();
  },
);

test("malformed JSON keeps the existing empty 200 behavior with a bounded reason", async () => {
  const req = {
    ...request(),
    text: async () => '{"private malformed payload',
  } as NextRequest;
  const result = await POST(req);
  expect(result.status).toBe(200);
  expect(result.headers.get("X-HackerAI-Next-Actions-Reason")).toBe(
    "invalid_request",
  );
  expect(JSON.stringify(capture.mock.calls)).not.toContain("private malformed");
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
        knownCost: 0,
        providerCalls: 0,
        pricedProviderCalls: 0,
        unknownProviderCalls: 0,
        modelIds: [],
        unavailable: false,
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
          account_metadata_version: 1,
          account_cohort: "non_internal",
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

test("restores an older saved batch without model work or a second enrollment event", async () => {
  chat.last_run_finished_at = Date.now() - 86_400_000;
  const batch = {
    batchId: "saved",
    validationVersion: 5,
    messageId: "answer",
    mode: "ask",
    suggestions: ["Explain the missing impact evidence."],
  };
  saved = { consumed: false, batch };
  const result = await POST(
    request({ chatId, messageId: "answer", restoreOnly: true } as never),
  );
  expect(await result.json()).toEqual(batch);
  expect(generateNextActions).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
});

test.each([undefined, 3, 4])(
  "does not restore legacy prediction version %s or make a model call",
  async (validationVersion) => {
    saved = {
      consumed: false,
      batch: {
        batchId: "legacy",
        validationVersion,
        messageId: "answer",
        mode: "ask",
        suggestions: ["Explain the evidence."],
      },
    };
    const result = await POST(
      request({ chatId, messageId: "answer", restoreOnly: true } as never),
    );
    expect(await result.json()).toEqual({ suggestions: [] });
    expect(generateNextActions).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  },
);

test("does not expose an legacy batch returned by a concurrent save", async () => {
  mutation.mockResolvedValueOnce({
    batchId: "legacy-concurrent",
    messageId: "answer",
    mode: "ask",
    suggestions: ["Explain the evidence."],
  });
  expect(await (await POST(request())).json()).toEqual({ suggestions: [] });
});

test("saves the prediction version alongside new drafts", async () => {
  await POST(request());
  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      batch: expect.objectContaining({ validationVersion: 5 }),
    }),
  );
});

test("emits partial known spend and unknown-call coverage on unavailable generation", async () => {
  jest.mocked(generateNextActions).mockResolvedValueOnce({
    suggestions: [],
    unavailable: true,
    inputTokens: undefined,
    outputTokens: undefined,
    reasoningTokens: undefined,
    modelId: "deepseek/deepseek-v4.1-flash-1017",
    modelIds: ["deepseek/deepseek-v4.1-flash-1017"],
    providerCalls: 2,
    pricedProviderCalls: 1,
    unknownProviderCalls: 1,
    knownCost: 0.0001,
    cost: undefined,
  });
  expect(await (await POST(request())).json()).toEqual({ suggestions: [] });
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "contextual_next_actions_generated",
      properties: expect.objectContaining({
        outcome: "unavailable",
        prompt_version: "task-progress-single-reply-v7",
        cost_usd: undefined,
        known_cost_usd: 0.0001,
        provider_calls: 2,
        priced_provider_calls: 1,
        unknown_provider_calls: 1,
      }),
    }),
  );
  expect(mutation).not.toHaveBeenCalled();
});

test.each(["consumed", "absent", "control", "disabled"])(
  "restoration stays empty for %s without generating",
  async (condition) => {
    saved =
      condition === "consumed"
        ? { consumed: true }
        : condition === "absent"
          ? null
          : { consumed: false, batch: { suggestions: ["Private suggestion"] } };
    if (condition === "control")
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue("control");
    if (condition === "disabled")
      jest.mocked(getPostHogFlagWithoutExposure).mockResolvedValue(false);
    const result = await POST(
      request({ chatId, messageId: "answer", restoreOnly: true } as never),
    );
    expect(await result.json()).toEqual({ suggestions: [] });
    expect(generateNextActions).not.toHaveBeenCalled();
  },
);

test("only returns a new batch after the database commits it", async () => {
  mutation.mockResolvedValueOnce(null);
  const result = await POST(request());
  expect(await result.json()).toEqual({ suggestions: [] });
  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      userId: "owner",
      chatId,
      messageId: "answer",
      finishedAt: chat.last_run_finished_at,
    }),
  );
});

test("consumption is bound to the authenticated user rather than caller identity", async () => {
  await DELETE(request());
  expect(mutation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ userId: "owner", chatId, messageId: "answer" }),
  );
  expect(generateNextActions).not.toHaveBeenCalled();
});

test.each([false, true])(
  "opt-out blocks generation and restoration (restoreOnly=%s) before spend or content",
  async (restoreOnly) => {
    predictionsEnabled = false;
    saved = {
      consumed: false,
      batch: { suggestions: ["Never restore while disabled"] },
    };
    const result = await POST(
      request({ chatId, messageId: "answer", restoreOnly } as never),
    );
    expect(await result.json()).toEqual({ suggestions: [] });
    expect(generateNextActions).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  },
);

test.each([0, 50000])(
  "completed Goal turns hide both new and saved suggestions (%i ms)",
  async (elapsed) => {
    achievedElapsedMs = elapsed;
    saved = {
      batch: {
        batchId: "old",
        messageId: "answer",
        mode: "agent",
        validationVersion: 5,
        suggestions: ["alpha"],
      },
    };
    expect((await (await POST(request())).json()).suggestions).toEqual([]);
    expect(generateNextActions).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  },
);

test("discards a draft if Goal achievement is persisted during prediction", async () => {
  jest.mocked(generateNextActions).mockImplementationOnce(async () => {
    achievedElapsedMs = 50000;
    return { suggestions: ["alpha"], unavailable: false } as Awaited<
      ReturnType<typeof generateNextActions>
    >;
  });
  expect((await (await POST(request())).json()).suggestions).toEqual([]);
  expect(mutation).not.toHaveBeenCalled();
});

test.each(["authenticate", "read_request", "consume"] as const)(
  "records one pending DELETE %s stage before the platform deadline, then clears the timer",
  async (stage) => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const req = request();
    if (stage === "authenticate")
      jest.mocked(getUserIDAndPro).mockImplementationOnce(async () => {
        await gate;
        return {
          userId: "owner",
          subscription: "pro",
          emailVerified: true,
          analyticsAccountCohort: "non_internal",
        };
      });
    if (stage === "read_request")
      req.text = async () => {
        await gate;
        return JSON.stringify({ chatId, messageId: "answer" });
      };
    if (stage === "consume")
      mutation.mockImplementationOnce(async () => {
        await gate;
        return true;
      });
    const pending = DELETE(req);
    try {
      await jest.advanceTimersByTimeAsync(9_999);
      expect(warn).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
        event: "next_actions_delete_slow_request",
        diagnostic_version: 1,
        stage,
        elapsed_ms: 10_000,
        warning_threshold_ms: 10_000,
        request_aborted: false,
        request_id: "iad1::qa123-1794060000000-abcdef123456",
      });
      release();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ suggestions: [] });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /owner|answer|serviceKey|suggestions/,
      );
    } finally {
      release();
      await pending;
      warn.mockRestore();
      jest.useRealTimers();
    }
  },
);

test("clears DELETE diagnostics on caught failures and excludes hostile request headers", async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const req = request();
    req.headers.set("x-vercel-id", "PRIVATE_TOKEN");
    jest
      .mocked(getUserIDAndPro)
      .mockRejectedValueOnce(new Error("PRIVATE auth"));
    expect((await DELETE(req)).status).toBe(200);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(warn).not.toHaveBeenCalled();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    req.text = async () => {
      await gate;
      throw new Error("PRIVATE body");
    };
    const pending = DELETE(req);
    await jest.advanceTimersByTimeAsync(10_000);
    release();
    expect((await pending).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
  } finally {
    warn.mockRestore();
    jest.useRealTimers();
  }
});

test("a throwing slow-warning sink cannot fail the pending DELETE", async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {
    throw new Error("PRIVATE sink");
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const req = request();
  req.text = async () => {
    await gate;
    return JSON.stringify({ chatId, messageId: "answer" });
  };
  const pending = DELETE(req);
  try {
    await expect(
      jest.advanceTimersByTimeAsync(10_000),
    ).resolves.toBeUndefined();
    release();
    expect((await pending).status).toBe(200);
  } finally {
    release();
    await pending;
    warn.mockRestore();
    jest.useRealTimers();
  }
});
