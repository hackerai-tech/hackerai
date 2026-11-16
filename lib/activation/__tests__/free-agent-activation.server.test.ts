/**
 * @jest-environment node
 */
import type { UIMessage } from "ai";
import {
  enforceFreeAgentActivationAskAdmission,
  evaluateFreeAgentActivation,
  evaluateFreeAgentActivationForStatus,
  freeAgentActivationAssignmentKey,
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
/** Same contract for the first-assignment get-or-set script. */
const assignmentStore = new Map<string, string>();
const mockAssignmentEval = jest.fn(
  async (_script: string, keys: string[], args: string[]) => {
    const [key] = keys;
    if (!assignmentStore.has(key)) assignmentStore.set(key, args[0]);
    // Upstash deserializes numeric-looking replies, so return a number.
    return Number(assignmentStore.get(key));
  },
);
let mockRedisAvailable = true;
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () =>
    mockRedisAvailable
      ? {
          scard: mockScard,
          eval: (script: string, keys: string[], args: string[]) =>
            keys[0].startsWith("free_agent_activation_assignment:")
              ? mockAssignmentEval(script, keys, args)
              : mockEval(script, keys, args),
        }
      : null,
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: () => null }));

const CUTOFF = "2026-11-15T00:00:00.000Z";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
// Sent by both macOS Safari and iPadOS Safari requesting the desktop site.
const SAFARI_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

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
/** posthog-node reports a failed /flags request only via its error event. */
const errorListeners = new Set<(error: unknown) => void>();
const emitPostHogError = (error: unknown) => {
  for (const listener of errorListeners) listener(error);
};
const posthog = {
  getFeatureFlagResult: mockGetFeatureFlagResult,
  capture: mockCapture,
  on: (event: string, listener: (error: unknown) => void) => {
    if (event !== "error") return () => {};
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  },
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
  assignmentStore.clear();
  errorListeners.clear();
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
        uuid: expect.stringMatching(UUID),
        timestamp: expect.any(Date),
        properties: {
          variant,
          definition_version: 1,
          "$feature/free_agent_activation_gate_v1": variant,
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

  it("sends one stable event UUID per user across repeated lookups and variants, distinct between users", async () => {
    await evaluate();
    await evaluate();
    mockGetFeatureFlagResult.mockResolvedValue(
      flagResult({ variant: "control" }),
    );
    await evaluate();
    await evaluate({ id: identity({ userId: "user_other" }) });
    const uuids = mockCapture.mock.calls.map(([event]) => event.uuid);

    expect(uuids).toHaveLength(4);
    for (const uuid of uuids) expect(uuid).toMatch(UUID);
    expect(new Set(uuids.slice(0, 3)).size).toBe(1);
    expect(uuids[3]).not.toBe(uuids[0]);
    // The SDK only honors the envelope UUID; no property-level insert ID.
    for (const [event] of mockCapture.mock.calls) {
      expect(event.properties).not.toHaveProperty("$insert_id");
    }
  });

  it("stamps every repeat with the stored first-assignment time, per user", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-15T10:00:00.000Z") });
    await evaluate();
    jest.setSystemTime(new Date("2026-11-18T08:00:00.000Z"));
    await evaluate();
    await evaluate({ id: identity({ userId: "user_other" }) });

    const stamps = mockCapture.mock.calls.map(([event]) =>
      (event.timestamp as Date).toISOString(),
    );
    expect(stamps).toEqual([
      "2026-11-15T10:00:00.000Z",
      "2026-11-15T10:00:00.000Z",
      "2026-11-18T08:00:00.000Z",
    ]);
    expect([...assignmentStore.keys()]).toEqual([
      freeAgentActivationAssignmentKey("user_new"),
      freeAgentActivationAssignmentKey("user_other"),
    ]);
    expect(
      isUserRateLimitKey(assignmentStore.keys().next().value!, "user_new"),
    ).toBe(true);
  });

  it("skips the assignment event but keeps enrollment when the marker is unavailable", async () => {
    mockRedisAvailable = false;
    await expect(evaluate()).resolves.toMatchObject({ variant: "test" });

    mockRedisAvailable = true;
    mockAssignmentEval.mockRejectedValueOnce(new Error("redis down"));
    await expect(evaluate()).resolves.toMatchObject({ variant: "test" });

    mockAssignmentEval.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers();
    const pending = evaluate();
    await jest.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toMatchObject({ variant: "test" });

    expect(mockCapture).not.toHaveBeenCalled();
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
    [
      "macOS Safari (identical to an iPad requesting the desktop site)",
      SAFARI_DESKTOP,
    ],
    [
      "Chrome on iOS in desktop mode",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Safari/605.1.15",
    ],
    [
      "Firefox on iOS in desktop mode",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Safari/605.1.15",
    ],
    [
      "Edge on iOS in desktop mode",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.0.0 Safari/605.1.15",
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
    DESKTOP_CHROME,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
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

  describe("status mode separates known exclusions from an unavailable flag", () => {
    const evaluateStatus = (args: { id?: FreeAgentActivationIdentity } = {}) =>
      evaluateFreeAgentActivationForStatus({
        request: request(),
        identity: args.id ?? identity(),
        posthog,
      });

    it.each<[string, () => void]>([
      [
        "a failed /flags request (SDK error event, undefined result)",
        () =>
          mockGetFeatureFlagResult.mockImplementation(async () => {
            emitPostHogError(new Error("PostHogFetchNetworkError"));
            return undefined;
          }),
      ],
      [
        "a rejected lookup",
        () => mockGetFeatureFlagResult.mockRejectedValue(new Error("boom")),
      ],
    ])("is unknown for %s, while Ask stays open", async (_, arrange) => {
      arrange();
      await expect(evaluateStatus()).resolves.toBeUndefined();
      await expect(evaluate()).resolves.toBeUndefined();
      expect(mockCapture).not.toHaveBeenCalled();
      expect(errorListeners.size).toBe(0);
    });

    it("is unknown for a stalled lookup", async () => {
      jest.useFakeTimers();
      mockGetFeatureFlagResult.mockImplementation(() => new Promise(() => {}));
      const pending = evaluateStatus();
      await jest.advanceTimersByTimeAsync(750);
      await expect(pending).resolves.toBeUndefined();
    });

    it.each<
      [string, { arrange?: () => void; id?: FreeAgentActivationIdentity }]
    >([
      [
        "an inactive or absent flag",
        {
          arrange: () => mockGetFeatureFlagResult.mockResolvedValue(undefined),
        },
      ],
      [
        "a disabled flag result",
        {
          arrange: () =>
            mockGetFeatureFlagResult.mockResolvedValue(
              flagResult({ enabled: false, variant: undefined }),
            ),
        },
      ],
      [
        "a missing cutoff payload",
        {
          arrange: () =>
            mockGetFeatureFlagResult.mockResolvedValue(
              flagResult({ payload: undefined }),
            ),
        },
      ],
      ["a paid account", { id: identity({ subscription: "pro" }) }],
    ])("is a known exclusion for %s", async (_, { arrange, id }) => {
      arrange?.();
      await expect(evaluateStatus({ id })).resolves.toBeNull();
    });

    it("recovers from an unavailable flag to a refused Ask once both stores answer", async () => {
      for (const responseId of ["r1", "r2", "r3"]) await record(responseId);
      mockGetFeatureFlagResult.mockRejectedValueOnce(new Error("flags down"));
      await expect(evaluateStatus()).resolves.toBeUndefined();

      const recovered = await evaluateStatus();
      expect(recovered).toEqual(enrollment);
      await expect(getFreeAgentActivationStatus(recovered)).resolves.toEqual(
        expect.objectContaining({ requiresAgent: true }),
      );
      await expect(
        enforceFreeAgentActivationAskAdmission(await evaluate()),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
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

  it("reports an unreadable count as unknown (not unenrolled), fails Ask open, then recovers to refuse", async () => {
    for (const id of ["r1", "r2", "r3"]) await record(id);
    mockRedisAvailable = false;
    await expect(
      getFreeAgentActivationStatus(enrollment),
    ).resolves.toBeUndefined();
    await expect(
      enforceFreeAgentActivationAskAdmission(enrollment),
    ).resolves.toBeUndefined();

    mockRedisAvailable = true;
    mockScard.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      getFreeAgentActivationStatus(enrollment),
    ).resolves.toBeUndefined();
    // Stored progress survived the outage; the next read refuses Ask.
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toEqual(
      expect.objectContaining({
        completedAskResponses: 3,
        requiresAgent: true,
      }),
    );
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

/**
 * Old-chain cleanup for a deferred regeneration runs as the post-save hook,
 * for both the primary and the provider-retry completion. It must follow a
 * qualified durable save of the matching reply, and only that.
 */
describe("post-save hook (deferred regeneration cleanup)", () => {
  const calls: string[] = [];
  const hook = jest.fn(async () => {
    calls.push("cleanup");
  });
  beforeEach(() => {
    calls.length = 0;
    hook.mockClear();
    mockEval.mockImplementation(async (_script, keys, args) => {
      calls.push("count");
      const members = store.get(keys[0]) ?? new Set<string>();
      if (!members.has(args[0]) && members.size < Number(args[1]))
        members.add(args[0]);
      store.set(keys[0], members);
      return members.size;
    });
  });

  it("runs after the durable save and after the count, once", async () => {
    let acknowledge!: (ack: unknown) => void;
    const pendingAck = new Promise<unknown>((resolve) => {
      acknowledge = resolve;
    });
    const pending = record("r1", {
      onPersistedSuccess: hook,
      persist: saveLoop("r1", [
        [{ id: "user-1", role: "user" }, null],
        [{ id: "r1", role: "assistant" }, pendingAck],
      ]),
    });
    await Promise.resolve();
    expect(hook).not.toHaveBeenCalled();

    acknowledge(null);
    await expect(pending).resolves.toBe(true);
    expect(calls).toEqual(["count", "cleanup"]);
  });

  it("runs without enrollment (flag off or unavailable) and counts nothing", async () => {
    await expect(
      record("r1", { enrollment: undefined, onPersistedSuccess: hook }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["cleanup"]);
  });

  it.each<[string, Partial<Parameters<typeof record>[1]>]>([
    [
      "a fenced (stale_run) save of the reply",
      {
        persist: saveLoop("r1", [
          [{ id: "r1", role: "assistant" }, "stale_run"],
        ]),
      },
    ],
    [
      "a save of only the user message",
      { persist: saveLoop("r1", [[{ id: "user-1", role: "user" }, null]]) },
    ],
    ["no final save", { persist: saveLoop("r1", []) }],
    ["a cancelled or failed provider outcome", { succeeded: false }],
    ["an empty reply", { messages: assistant("r1", "  ") }],
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
    ["an automatic continuation", { isAutoContinue: true }],
  ])("never runs for %s", async (_, overrides) => {
    await record("r1", { onPersistedSuccess: hook, ...overrides });
    expect(hook).not.toHaveBeenCalled();
  });

  it("never runs when the save throws, and the save error propagates", async () => {
    const saveError = new Error("convex save failed");
    await expect(
      record("r1", {
        onPersistedSuccess: hook,
        persist: () => Promise.reject(saveError),
      }),
    ).rejects.toBe(saveError);
    expect(hook).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a failing hook keeps the saved receipt and the count, and logs only the error type", async () => {
    const failing = jest.fn(async () => {
      throw new Error("REGENERATE_CHAIN_MISMATCH chat-private user-private");
    });

    await expect(record("r1", { onPersistedSuccess: failing })).resolves.toBe(
      true,
    );

    expect(failing).toHaveBeenCalledTimes(1);
    await expect(getFreeAgentActivationStatus(enrollment)).resolves.toEqual(
      expect.objectContaining({ completedAskResponses: 1 }),
    );
    const logged = consoleWarn.mock.calls.map(([line]) => String(line));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toEqual({
      level: "warn",
      event: "free_ask_persisted_success_hook_failed",
      service: "free-agent-activation",
      error_name: "Error",
    });
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
