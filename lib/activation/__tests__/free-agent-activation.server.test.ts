/**
 * @jest-environment node
 */
import type { UIMessage } from "ai";
import {
  enforceFreeAgentActivationAskAdmission,
  evaluateFreeAgentActivation,
  freeAgentActivationStorageKey,
  getFreeAgentActivationStatus,
  isFinalAssistantSaveReceipt,
  persistThenRecordFreeAgentAskResponse,
  type FreeAgentActivationEnrollment,
  type FreeAgentActivationIdentity,
} from "../free-agent-activation.server";
import {
  isFreeQuotaSubjectRateLimitKey,
  isUserRateLimitKey,
} from "@/lib/rate-limit/key-cleanup";

/**
 * In-memory Redis set store. `eval` reproduces the record script's documented
 * contract (idempotent add, capped at the limit); the Lua itself runs only in
 * real Redis and is not executed here.
 */
const store = new Map<string, Set<string>>();
const evalScripts: string[] = [];
const mockScard = jest.fn(async (key: string) => store.get(key)?.size ?? 0);
const mockEval = jest.fn(
  async (script: string, keys: string[], args: string[]) => {
    evalScripts.push(script);
    const [key] = keys;
    const [id, limit] = args;
    const members = store.get(key) ?? new Set<string>();
    if (!members.has(id) && members.size < Number(limit)) members.add(id);
    store.set(key, members);
    return members.size;
  },
);
let mockRedisAvailable = true;
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () =>
    mockRedisAvailable ? { scard: mockScard, eval: mockEval } : null,
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: () => null }));

const CUTOFF = "2026-11-15T00:00:00.000Z";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const flagResult = (
  overrides: Partial<{
    enabled: boolean;
    variant: string | undefined;
    payload: unknown;
  }> = {},
) => ({
  key: "free_agent_activation_gate_v1",
  enabled: true,
  variant: "test",
  payload: { new_users_from: CUTOFF },
  ...overrides,
});
const mockGetFeatureFlagResult = jest.fn();
const mockCapture = jest.fn();
const posthog = {
  getFeatureFlagResult: mockGetFeatureFlagResult,
  capture: mockCapture,
} as never;

const identity = (
  overrides: Partial<FreeAgentActivationIdentity> = {},
): FreeAgentActivationIdentity => ({
  userId: "user_new",
  subscription: "free",
  accountCreatedAt: "2026-11-15T09:30:00.000Z",
  freeQuotaSubject: "legacy_subject",
  freeUsageQuotaSubject: "free_quota:v2:shared",
  ...overrides,
});

const request = ({
  userAgent = DESKTOP_CHROME,
  country = "US",
  consent,
  extraHeaders = {},
}: {
  userAgent?: string | null;
  country?: string | null;
  consent?: string;
  extraHeaders?: Record<string, string>;
} = {}) => ({
  headers: new Headers({
    ...(userAgent !== null && { "user-agent": userAgent }),
    ...(country !== null && { "x-vercel-ip-country": country }),
    ...extraHeaders,
  }),
  cookies: {
    get: (name: string) =>
      name === "hackerai_analytics_consent" && consent
        ? { value: consent }
        : undefined,
  },
});

const evaluate = (
  args: {
    req?: ReturnType<typeof request>;
    id?: FreeAgentActivationIdentity;
  } = {},
) =>
  evaluateFreeAgentActivation({
    request: args.req ?? request(),
    identity: args.id ?? identity(),
    posthog,
  });

const assistant = (id: string, text = "Here is the answer."): UIMessage[] => [
  {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  },
];

const enrollment: FreeAgentActivationEnrollment = {
  variant: "test",
  quotaSubject: "free_quota:v2:shared",
};

/**
 * Mirrors the handler's save loops: saves each message in order (a rejected
 * acknowledgement propagates) and returns whether the final assistant
 * received a durable receipt.
 */
const saveLoop =
  (
    responseId: string,
    saves: Array<[{ id: string; role: string }, unknown]>,
  ): (() => Promise<boolean>) =>
  async () => {
    let finalAssistantSaved = false;
    for (const [message, acknowledgement] of saves) {
      const ack = await acknowledgement;
      if (isFinalAssistantSaveReceipt(message, responseId, ack)) {
        finalAssistantSaved = true;
      }
    }
    return finalAssistantSaved;
  };

const record = (
  responseId: string,
  overrides: Partial<
    Parameters<typeof persistThenRecordFreeAgentAskResponse>[0]
  > = {},
) =>
  persistThenRecordFreeAgentAskResponse({
    enrollment,
    mode: "ask",
    isAutoContinue: false,
    succeeded: true,
    messages: assistant(responseId),
    responseId,
    persist: saveLoop(responseId, [
      [{ id: "user-1", role: "user" }, null],
      [{ id: responseId, role: "assistant" }, null],
    ]),
    ...overrides,
  });

let consoleWarn: jest.SpyInstance;
beforeEach(() => {
  store.clear();
  evalScripts.length = 0;
  mockRedisAvailable = true;
  jest.clearAllMocks();
  mockCapture.mockImplementation(() => {});
  mockGetFeatureFlagResult.mockResolvedValue(flagResult());
  consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  consoleWarn.mockRestore();
});

describe("free Agent activation eligibility", () => {
  it("enrolls an eligible new desktop-browser free user on the shared quota subject without recording exposure", async () => {
    await expect(evaluate()).resolves.toEqual({
      variant: "test",
      quotaSubject: "free_quota:v2:shared",
    });
    expect(mockGetFeatureFlagResult).toHaveBeenCalledWith(
      "free_agent_activation_gate_v1",
      "user_new",
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription: "free" },
      },
    );
  });

  it.each(["test", "control"])(
    "records a privacy-safe server assignment for an enrolled %s user",
    async (variant) => {
      mockGetFeatureFlagResult.mockResolvedValue(flagResult({ variant }));
      await evaluate();
      expect(mockCapture).toHaveBeenCalledTimes(1);
      const event = mockCapture.mock.calls[0][0];
      expect(event).toEqual({
        distinctId: "user_new",
        event: "free_agent_activation_assigned",
        properties: {
          variant,
          definition_version: 1,
          "$feature/free_agent_activation_gate_v1": variant,
          $insert_id: "free_agent_activation_gate_v1:user_new:assigned",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      });
      const serialized = JSON.stringify(event);
      for (const privateValue of [
        "free_quota",
        "legacy_subject",
        "Mozilla",
        "2026-11-15T09:30",
        CUTOFF,
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    },
  );

  it("records the same insert ID on repeated lookups so readouts keep the first assignment", async () => {
    await evaluate();
    await evaluate();
    const insertIds = mockCapture.mock.calls.map(
      ([event]) => event.properties.$insert_id,
    );
    expect(new Set(insertIds).size).toBe(1);
  });

  it("keeps the enrollment when assignment capture throws", async () => {
    mockCapture.mockImplementation(() => {
      throw new Error("posthog queue full");
    });
    await expect(evaluate()).resolves.toEqual({
      variant: "test",
      quotaSubject: "free_quota:v2:shared",
    });
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      "a paid account",
      () => evaluate({ id: identity({ subscription: "pro" }) }),
    ],
    [
      "a mobile browser",
      () => evaluate({ req: request({ userAgent: "Mozilla/5.0 (iPhone)" }) }),
    ],
    [
      "a subscription-first country",
      () => evaluate({ req: request({ country: "IN" }) }),
    ],
    [
      "a pre-cutoff account",
      () =>
        evaluate({
          id: identity({ accountCreatedAt: "2026-11-01T00:00:00.000Z" }),
        }),
    ],
    [
      "an inactive flag",
      () => {
        mockGetFeatureFlagResult.mockResolvedValue(
          flagResult({ enabled: false, variant: undefined }),
        );
        return evaluate();
      },
    ],
  ])("records no assignment for %s", async (_, run) => {
    await expect(run()).resolves.toBeUndefined();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("bounds a stalled flag lookup and enrolls no one", async () => {
    jest.useFakeTimers();
    mockGetFeatureFlagResult.mockImplementation(() => new Promise(() => {}));
    const pending = evaluate();
    await jest.advanceTimersByTimeAsync(749);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("falls back to the legacy subject, then the user ID, like the existing free limits", async () => {
    await expect(
      evaluate({ id: identity({ freeUsageQuotaSubject: undefined }) }),
    ).resolves.toMatchObject({ quotaSubject: "legacy_subject" });
    await expect(
      evaluate({
        id: identity({
          freeUsageQuotaSubject: undefined,
          freeQuotaSubject: undefined,
        }),
      }),
    ).resolves.toMatchObject({ quotaSubject: "user_new" });
  });

  it.each([
    ["exactly at the cutoff", "2026-11-15T00:00:00.000Z", true],
    [
      "at the cutoff with an explicit offset",
      "2026-11-15T01:00:00+01:00",
      true,
    ],
    ["one millisecond before the cutoff", "2026-11-14T23:59:59.999Z", false],
    ["a calendar rollover", "2026-11-31T00:00:00.000Z", false],
    ["a date without a zone", "2026-11-16T00:00:00", false],
    ["a date-only value", "2026-11-16", false],
    ["a missing creation time", undefined, false],
  ])(
    "uses the authenticated account creation time (%s)",
    async (_, accountCreatedAt, enrolled) => {
      const result = await evaluate({ id: identity({ accountCreatedAt }) });
      expect(Boolean(result)).toBe(enrolled);
    },
  );

  it.each([
    ["paid account", { subscription: "pro" }],
    ["team member", { organizationId: "org_1" }],
  ])(
    "excludes a %s before any flag lookup",
    async (_, overrides: Partial<FreeAgentActivationIdentity>) => {
      await expect(
        evaluate({ id: identity(overrides) }),
      ).resolves.toBeUndefined();
      expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ],
    [
      "Android tablet",
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ],
    [
      "iPad",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ],
    [
      "native Desktop app",
      `${DESKTOP_CHROME.replace("Chrome/141.0.0.0 ", "")} HackerAI-Desktop/1.0`,
    ],
    ["missing user agent", null],
    ["non-browser client", "curl/8.7.1"],
  ])("excludes a %s", async (_, userAgent) => {
    await expect(
      evaluate({ req: request({ userAgent }) }),
    ).resolves.toBeUndefined();
    expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
  });

  it("excludes a mobile client hint even with a desktop user agent", async () => {
    await expect(
      evaluate({
        req: request({ extraHeaders: { "sec-ch-ua-mobile": "?1" } }),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  ])("accepts a supported desktop browser: %s", async (userAgent) => {
    await expect(evaluate({ req: request({ userAgent }) })).resolves.toEqual(
      expect.objectContaining({ variant: "test" }),
    );
  });

  it.each(["IN", "PK", "BD", "NG", "ID", "IR"])(
    "excludes subscription-first country %s even with analytics consent",
    async (country) => {
      await expect(
        evaluate({ req: request({ country, consent: "accepted" }) }),
      ).resolves.toBeUndefined();
      expect(mockGetFeatureFlagResult).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["declined consent where none is required", "US", "declined", false],
    ["no consent where consent is required", "DE", undefined, false],
    ["accepted consent where consent is required", "DE", "accepted", true],
    ["an unknown country without consent", null, undefined, false],
    ["an unknown country with consent", null, "accepted", true],
  ])(
    "respects analytics consent: %s",
    async (_, country, consent, enrolled) => {
      const result = await evaluate({ req: request({ country, consent }) });
      expect(Boolean(result)).toBe(enrolled);
    },
  );

  it.each([
    ["an inactive flag", flagResult({ enabled: false, variant: undefined })],
    ["an unknown variant", flagResult({ variant: "holdout" })],
    ["a boolean flag", flagResult({ variant: undefined })],
    ["a missing payload", flagResult({ payload: undefined })],
    ["a payload without a cutoff", flagResult({ payload: {} })],
    [
      "a non-strict cutoff",
      flagResult({ payload: { new_users_from: "2026-11-15" } }),
    ],
    ["a malformed JSON payload", flagResult({ payload: "{not json" })],
    ["an unavailable flag", undefined],
  ])("does not enroll with %s", async (_, result) => {
    mockGetFeatureFlagResult.mockResolvedValue(result);
    await expect(evaluate()).resolves.toBeUndefined();
  });

  it("accepts a JSON-string payload and the control variant", async () => {
    mockGetFeatureFlagResult.mockResolvedValue(
      flagResult({
        variant: "control",
        payload: JSON.stringify({ new_users_from: CUTOFF }),
      }),
    );
    await expect(evaluate()).resolves.toMatchObject({ variant: "control" });
  });

  it("fails open when PostHog rejects", async () => {
    mockGetFeatureFlagResult.mockRejectedValue(new Error("network"));
    await expect(evaluate()).resolves.toBeUndefined();
  });
});

describe("free Agent activation status and Ask admission", () => {
  it("gates treatment Ask at the third persisted response and survives a later day", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-15T10:00:00Z") });
    for (const id of ["r1", "r2"]) await record(id);
    await expect(
      enforceFreeAgentActivationAskAdmission(enrollment),
    ).resolves.toBeUndefined();
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toEqual({
      variant: "test",
      completedAskResponses: 2,
      introLimit: 3,
      requiresAgent: false,
    });

    await record("r3");
    jest.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    await expect(
      enforceFreeAgentActivationAskAdmission(enrollment),
    ).rejects.toMatchObject({
      statusCode: 403,
      metadata: { free_agent_activation_required: true },
    });
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toEqual({
      variant: "test",
      completedAskResponses: 3,
      introLimit: 3,
      requiresAgent: true,
    });
    for (const script of evalScripts) expect(script).not.toMatch(/EXPIRE/i);
  });

  it("never gates control, reporting its progress without requiring Agent", async () => {
    const control = { ...enrollment, variant: "control" as const };
    for (const id of ["r1", "r2", "r3", "r4"])
      await record(id, { enrollment: control });
    await expect(
      enforceFreeAgentActivationAskAdmission(control),
    ).resolves.toBeUndefined();
    expect(mockScard).not.toHaveBeenCalled();
    await expect(getFreeAgentActivationStatus(control)).resolves.toEqual({
      variant: "control",
      completedAskResponses: 3,
      introLimit: 3,
      requiresAgent: false,
    });
  });

  it("does nothing without an enrollment", async () => {
    await expect(
      enforceFreeAgentActivationAskAdmission(undefined),
    ).resolves.toBeUndefined();
    await expect(getFreeAgentActivationStatus(undefined)).resolves.toBeNull();
    expect(mockScard).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable storage from zero and fails open without resetting progress", async () => {
    for (const id of ["r1", "r2", "r3"]) await record(id);
    mockRedisAvailable = false;
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toBeNull();
    await expect(
      enforceFreeAgentActivationAskAdmission(enrollment),
    ).resolves.toBeUndefined();

    mockRedisAvailable = true;
    mockScard.mockRejectedValueOnce(new Error("redis down"));
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toBeNull();
    await expect(
      enforceFreeAgentActivationAskAdmission(enrollment),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("bounds a stalled storage read and fails open", async () => {
    jest.useFakeTimers();
    mockScard.mockImplementationOnce(() => new Promise<number>(() => {}));
    const pending = enforceFreeAgentActivationAskAdmission(enrollment);
    await jest.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("recording persisted Ask responses", () => {
  it("counts a durable (null) save acknowledgement for the final assistant", async () => {
    await expect(record("r1")).resolves.toBe(true);
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Array<[{ id: string; role: string }, unknown]>]>([
    [
      "a fenced stale-run acknowledgement",
      [
        [{ id: "u1", role: "user" }, null],
        [{ id: "r1", role: "assistant" }, "stale_run"],
      ],
    ],
    [
      "an unrecognized acknowledgement",
      [[{ id: "r1", role: "assistant" }, { ok: true }]],
    ],
    ["only the user message being saved", [[{ id: "u1", role: "user" }, null]]],
    [
      "only an earlier assistant message being saved",
      [[{ id: "loop-recovery", role: "assistant" }, null]],
    ],
    ["no saves at all", []],
  ])("does not count %s", async (_, saves) => {
    await expect(
      record("r1", { persist: saveLoop("r1", saves) }),
    ).resolves.toBe(false);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("counts a retried response ID once and caps storage at the limit", async () => {
    await record("r1");
    await record("r1");
    await expect(
      getFreeAgentActivationStatus(enrollment),
    ).resolves.toMatchObject({ completedAskResponses: 1 });
    for (const id of ["r2", "r3", "r4", "r5"]) await record(id);
    expect(
      store.get(freeAgentActivationStorageKey("free_quota:v2:shared")),
    ).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("does not count when the save fails and propagates the save error", async () => {
    const saveError = new Error("convex save failed");
    await expect(
      record("r1", { persist: () => Promise.reject(saveError) }),
    ).rejects.toBe(saveError);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("does not count while the final save is pending", async () => {
    let acknowledge!: (ack: unknown) => void;
    const pendingAck = new Promise<unknown>((resolve) => {
      acknowledge = resolve;
    });
    const pending = record("r1", {
      persist: saveLoop("r1", [[{ id: "r1", role: "assistant" }, pendingAck]]),
    });
    await Promise.resolve();
    expect(mockEval).not.toHaveBeenCalled();
    acknowledge(null);
    await expect(pending).resolves.toBe(true);
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an aborted, failed or empty outcome", { succeeded: false }],
    ["Agent mode", { mode: "agent" }],
    ["an automatic continuation", { isAutoContinue: true }],
    ["no enrollment", { enrollment: undefined }],
    [
      "a reasoning-only reply",
      {
        messages: [
          {
            id: "r1",
            role: "assistant",
            parts: [{ type: "reasoning", text: "thinking" }],
          },
        ] as UIMessage[],
      },
    ],
    ["a whitespace reply", { messages: assistant("r1", "   ") }],
    ["a reply with a different ID", { messages: assistant("other") }],
  ])("does not count %s", async (_, overrides) => {
    await expect(record("r1", overrides)).resolves.toBe(true);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("keeps the saved reply when recording fails", async () => {
    mockEval.mockRejectedValueOnce(new Error("redis down"));
    await expect(record("r1")).resolves.toBe(true);
  });
});

it("is removed by the existing account cleanup ownership matcher", () => {
  const key = freeAgentActivationStorageKey("user_123");
  expect(isUserRateLimitKey(key, "user_123")).toBe(true);
  expect(
    isFreeQuotaSubjectRateLimitKey(
      freeAgentActivationStorageKey("free_quota:v2:x"),
      "free_quota:v2:x",
    ),
  ).toBe(true);
});
