import type { ToolContext } from "@/types";
import { createBrowserChallengeHandler } from "../../captcha/browser-challenge";
import { DETECT_CHALLENGES_SCRIPT } from "../../captcha/detection";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";

jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));
const flag = jest.mocked(getPostHogBooleanFlagDecisionForUser);
const observation = {
  url: "https://www.google.com/recaptcha/api2/demo",
  documentId: "document-1",
  widgets: [
    {
      kind: "recaptcha_v2" as const,
      siteKey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
      observationId: "0123456789abcdef0123456789abcdef",
      tokenPresent: false,
      invisible: false,
    },
  ],
  interstitial: false,
};
const originalEnv = process.env;
const originalFetch = global.fetch;

it.each([true, false])(
  "uses managed Cloudflare solving only with a transport that can apply the returned user agent: %s",
  async (supported) => {
    process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW = "1";
    process.env.HACKERAI_ENVIRONMENT = "preview";
    process.env.CAPTCHA_CLOUDFLARE_PREVIEW_URLS = JSON.stringify([
      "https://dash.cloudflare.com/sign-up",
    ]);
    const data = {
      ...observation,
      url: "https://dash.cloudflare.com/sign-up",
      interstitial: true,
      widgets: [
        {
          ...observation.widgets[0],
          kind: "turnstile",
          managed: {
            action: "managed",
            data: "opaque",
            pagedata: "opaque-page",
            userAgent: "original-browser",
          },
        },
      ],
    };
    const evaluate = jest
      .fn()
      .mockResolvedValueOnce(data)
      .mockResolvedValue({ status: "token_delivered" });
    const deliverCloudflare = jest.fn(async () => ({
      status: "token_delivered",
    }));
    const { context, journal } = setup();
    context.browserSessions = {
      getChallengeBrowser: async () => ({
        identity: "owner",
        evaluate,
        ...(supported && { deliverCloudflare }),
      }),
    } as unknown as NonNullable<ToolContext["browserSessions"]>;
    const solve = jest.fn(async () => ({
      token: "private-response",
      costDollars: 0.00145,
      userAgent: "solver-browser",
    }));
    const handler = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      () => ({ solve }),
      journal,
    );
    const result = await handler();
    if (supported) {
      expect(result).toMatchObject({
        status: "token_delivered",
        websiteAccepted: false,
      });
      expect(deliverCloudflare).toHaveBeenCalledWith(
        "solver-browser",
        expect.objectContaining({
          url: data.url,
          documentId: data.documentId,
          originalUserAgent: "original-browser",
        }),
        expect.any(String),
      );
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(
        /opaque|private-response|solver-browser/,
      );
      evaluate.mockResolvedValueOnce(data);
      expect(await handler()).toMatchObject({ reason: "attempt_limit" });
      expect(solve).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ reason: "unsupported_transport" });
      expect(solve).not.toHaveBeenCalled();
      expect(journal.reserve).not.toHaveBeenCalled();
    }
  },
);
const cloneObservation = () => ({
  ...observation,
  widgets: observation.widgets.map((widget) => ({ ...widget })),
});
function setup(environment = "PREVIEW", overrides: Partial<ToolContext> = {}) {
  const evaluate = jest.fn(async (script: string) =>
    script === DETECT_CHALLENGES_SCRIPT
      ? cloneObservation()
      : { status: "token_delivered" },
  );
  const getChallengeBrowser = jest.fn(async () => ({
    identity: "owner:default",
    evaluate,
  }));
  const onToolCost = jest.fn();
  const context = {
    userID: "internal-user",
    triggerRunId: "run-1",
    browserSessions: { getChallengeBrowser },
    onToolCost,
    ...overrides,
  } as unknown as ToolContext;
  const solve = jest.fn(async () => ({
    token: "private-response",
    costDollars: 0.003,
  }));
  const journal = {
    reserve: jest.fn(async () => true),
    registerTask: jest.fn(async () => {}),
    recordCost: jest.fn(async () => {}),
  };
  const solverFactory = jest.fn(() => ({ solve }));
  const tool = createBrowserChallengeHandler(
    context,
    environment,
    undefined,
    solverFactory,
    journal,
  );
  return {
    tool,
    context,
    journal,
    solve,
    evaluate,
    getChallengeBrowser,
    onToolCost,
    solverFactory,
  };
}
const run = (
  tool: ReturnType<typeof createBrowserChallengeHandler>,
  action: "inspect" | "solve",
  abortSignal?: AbortSignal,
) => {
  if (action === "solve") process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW = "1";
  return tool(abortSignal);
};

beforeEach(() => {
  jest.clearAllMocks();
  flag.mockResolvedValue(true);
  process.env = {
    ...originalEnv,
    HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
    CAPTCHA_SOLVER_PREVIEW_USER_IDS: "internal-user",
    TWOCAPTCHA_API_KEY: "private-provider-key",
  };
  delete process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW;
});

it("automatically solves only a detected supported challenge once in the existing browser", async () => {
  process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW = "1";
  process.env.HACKERAI_ENVIRONMENT = "preview";
  const { tool, solve, evaluate, solverFactory } = setup();
  evaluate.mockResolvedValueOnce({ ...cloneObservation(), widgets: [] });
  expect(await run(tool, "inspect")).toEqual({
    status: "no_pending_challenge",
  });
  expect(solve).not.toHaveBeenCalled();
  expect(solverFactory).not.toHaveBeenCalled();
  const detected = await run(tool, "inspect");
  expect(detected).toMatchObject({
    status: "token_delivered",
    provider: "2captcha",
    providerTaskCreated: true,
    providerCostUSD: 0.003,
    websiteAccepted: false,
    guidance: expect.any(String),
  });
  const repeated = await run(tool, "inspect");
  expect(repeated).toMatchObject({ reason: "attempt_limit" });
  expect(repeated).not.toHaveProperty("guidance");
  expect(solverFactory).toHaveBeenCalledTimes(1);
  expect(solve).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["PRODUCTION", "STAGING", "DEVELOPMENT", "preview", "unknown"])(
  "never inspects a browser or contacts a solver in %s",
  async (environment) => {
    const { tool, getChallengeBrowser, solve } = setup(environment);
    await expect(run(tool, "solve")).resolves.toEqual({
      status: "unavailable",
    });
    await expect(run(tool, "inspect")).resolves.toEqual({
      status: "unavailable",
    });
    expect(getChallengeBrowser).not.toHaveBeenCalled();
    expect(solve).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  },
);

it.each([
  "not allowlisted",
  "explicit enablement missing",
  "approval mode",
  "Ask mode",
])("preserves the eligibility boundary: %s", async (reason) => {
  if (reason === "not allowlisted")
    process.env.CAPTCHA_SOLVER_PREVIEW_USER_IDS = "another-user";
  if (reason === "explicit enablement missing")
    delete process.env.HACKERAI_CAPTCHA_SOLVER_PREVIEW;
  const { tool, solve, getChallengeBrowser } = setup(
    "PREVIEW",
    reason === "approval mode"
      ? { requestToolApproval: jest.fn() }
      : reason === "Ask mode"
        ? { triggerRunId: undefined }
        : {},
  );
  await expect(run(tool, "solve")).resolves.toEqual({ status: "unavailable" });
  expect(getChallengeBrowser).not.toHaveBeenCalled();
  expect(solve).not.toHaveBeenCalled();
});

it("detects without spending, exposes no site key and respects a disabled flag", async () => {
  const { tool, solve } = setup();
  await expect(run(tool, "inspect")).resolves.toEqual({
    status: "challenge_detected",
    demoEligible: true,
    widgets: [{ kind: "recaptcha_v2", invisible: false }],
    interstitial: false,
    message: expect.any(String),
    visionGuidance: expect.any(String),
    guidance: expect.any(String),
  });
  expect(solve).not.toHaveBeenCalled();
  flag.mockResolvedValue(false);
  await expect(run(tool, "solve")).resolves.toEqual({ status: "unavailable" });
  expect(solve).not.toHaveBeenCalled();
});

it("offers the vision workflow for an allowlisted hCaptcha demo without a solver credential", async () => {
  delete process.env.TWOCAPTCHA_API_KEY;
  const { tool, evaluate, solve } = setup();
  evaluate.mockResolvedValue({
    ...cloneObservation(),
    url: "https://accounts.hcaptcha.com/demo",
    widgets: [{ ...observation.widgets[0], kind: "hcaptcha" }],
  });
  await expect(run(tool, "inspect")).resolves.toMatchObject({
    status: "challenge_detected",
    demoEligible: true,
    widgets: [{ kind: "hcaptcha", invisible: false }],
    visionGuidance: expect.any(String),
  });
  expect(solve).not.toHaveBeenCalled();
});

it.each(["other site", "invisible", "interstitial", "turnstile", "multiple"])(
  "keeps the vision pilot confined to visible, allowlisted image challenges: %s",
  async (variant) => {
    const { tool, evaluate, solve } = setup();
    const data = cloneObservation();
    if (variant === "other site") data.url = "https://example.com/login";
    if (variant === "invisible") data.widgets[0].invisible = true;
    if (variant === "interstitial") data.interstitial = true;
    if (variant === "turnstile")
      (data.widgets[0] as { kind: string }).kind = "turnstile";
    if (variant === "multiple") data.widgets.push({ ...data.widgets[0] });
    evaluate.mockResolvedValue(data);
    const result = await run(tool, "inspect");
    expect(result).toMatchObject({ status: "challenge_detected" });
    expect(result).not.toHaveProperty("visionGuidance");
    expect(solve).not.toHaveBeenCalled();
  },
);

it("requests handoff without contacting a provider when no solver key exists", async () => {
  delete process.env.TWOCAPTCHA_API_KEY;
  const { tool, solve } = setup();
  await expect(run(tool, "solve")).resolves.toEqual({
    status: "handoff_required",
    reason: "solver_not_configured",
    guidance: expect.any(String),
  });
  expect(solve).not.toHaveBeenCalled();
});

it("reports uncertain delivery separately from a provider failure", async () => {
  const { tool, evaluate, onToolCost } = setup();
  evaluate.mockImplementation(async (script) => {
    if (script === DETECT_CHALLENGES_SCRIPT) return cloneObservation();
    throw new Error("private-response ambiguous delivery");
  });
  await expect(run(tool, "solve")).resolves.toMatchObject({
    status: "handoff_required",
    reason: "delivery_outcome_unknown",
  });
  expect(onToolCost).toHaveBeenCalledWith(0.003);
  expect(phLogger.event).toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({
      outcome: "delivery_outcome_unknown",
      charge_status: "recorded",
    }),
  );
});

it("fails closed after a one-second flag timeout", async () => {
  jest.useFakeTimers();
  flag.mockReturnValue(new Promise(() => {}));
  const { tool, getChallengeBrowser } = setup();
  const pending = run(tool, "solve");
  await jest.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toEqual({ status: "unavailable" });
  expect(getChallengeBrowser).not.toHaveBeenCalled();
});

it("delivers once, accounts for cost, and never claims website acceptance or exposes secrets", async () => {
  const { tool, solve, onToolCost, evaluate } = setup();
  const result = await run(tool, "solve");
  expect(result).toMatchObject({
    status: "token_delivered",
    websiteAccepted: false,
  });
  expect(onToolCost).toHaveBeenCalledWith(0.003);
  const emitted = JSON.stringify([
    result,
    jest.mocked(phLogger.event).mock.calls,
  ]);
  for (const value of [
    "private-provider-key",
    "private-response",
    observation.widgets[0].siteKey,
    observation.url,
  ])
    expect(emitted).not.toContain(value);
  expect(evaluate).toHaveBeenCalledTimes(2);
  await expect(run(tool, "solve")).resolves.toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
});

it("does not retry an ambiguous paid failure, and hands off with a sanitized result", async () => {
  const { tool, solve } = setup();
  solve.mockRejectedValue(new Error("private-provider-key private-response"));
  await expect(run(tool, "solve")).resolves.toEqual({
    status: "handoff_required",
    reason: "challenge_operation_failed",
    guidance: expect.any(String),
  });
  await expect(run(tool, "solve")).resolves.toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
});

it("reports the solver deadline without delivering or creating another paid task", async () => {
  const { tool, solve, evaluate, onToolCost } = setup();
  solve.mockRejectedValue(
    new DOMException("private-provider-detail", "TimeoutError"),
  );
  const result = await run(tool, "solve");
  expect(result).toMatchObject({
    status: "handoff_required",
    reason: "solver_timeout",
  });
  expect(JSON.stringify(result)).not.toContain("private-provider-detail");
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(onToolCost).not.toHaveBeenCalled();
  await expect(run(tool, "solve")).resolves.toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
});

it("does not mislabel the run's own timeout as a provider timeout", async () => {
  const { tool, solve } = setup();
  const controller = new AbortController();
  const reason = new DOMException("Run deadline", "TimeoutError");
  solve.mockImplementation(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(run(tool, "solve", controller.signal)).rejects.toBe(reason);
  expect(phLogger.event).not.toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "solver_timeout" }),
  );
});

it.each(["denied", "ambiguous write"])(
  "does not create a paid task after journal admission is %s",
  async (variant) => {
    const { tool, solve, journal } = setup();
    if (variant === "denied") journal.reserve.mockResolvedValue(false);
    else
      journal.reserve.mockRejectedValue(new Error("private-database-detail"));
    const result = await run(tool, "solve");
    expect(result).toMatchObject({ status: "handoff_required" });
    expect(JSON.stringify(result)).not.toContain("private-database-detail");
    await expect(run(tool, "solve")).resolves.toMatchObject({
      reason: "attempt_limit",
    });
    expect(solve).not.toHaveBeenCalled();
    expect(journal.reserve).toHaveBeenCalledTimes(1);
  },
);

it("blocks concurrent calls instead of creating duplicate paid tasks", async () => {
  const { tool, solve } = setup();
  let resolve!: (value: { token: string; costDollars: number }) => void;
  let started!: () => void;
  const admitted = new Promise<void>((done) => {
    started = done;
  });
  solve.mockImplementation(() => {
    started();
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = run(tool, "solve");
  await admitted;
  await expect(run(tool, "solve")).resolves.toMatchObject({ status: "busy" });
  resolve({ token: "private-response", costDollars: 0.003 });
  await pending;
  expect(solve).toHaveBeenCalledTimes(1);
});

it("does not deliver a late response after Stop", async () => {
  const { tool, solve, evaluate } = setup();
  const controller = new AbortController();
  solve.mockImplementation(async () => {
    controller.abort(new Error("stopped"));
    return { token: "private-response", costDollars: 0.003 };
  });
  await expect(run(tool, "solve", controller.signal)).rejects.toThrow(
    "stopped",
  );
  expect(evaluate).toHaveBeenCalledTimes(1);
});

it("does not load guidance or the provider when inspection fails before detecting a challenge", async () => {
  const { tool, getChallengeBrowser, solverFactory } = setup();
  getChallengeBrowser.mockRejectedValue(new Error("browser unavailable"));
  const result = await run(tool, "solve");
  expect(result).toMatchObject({
    status: "handoff_required",
    reason: "challenge_operation_failed",
  });
  expect(result).not.toHaveProperty("guidance");
  expect(solverFactory).not.toHaveBeenCalled();
});

it("does not create a paid task if stopped while the provider initializes", async () => {
  const { context, journal, solve, evaluate, onToolCost } = setup();
  const controller = new AbortController();
  let ready!: () => void;
  let initialize!: (value: { solve: typeof solve }) => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const factory = jest.fn(() => {
    ready();
    return new Promise<{ solve: typeof solve }>((resolve) => {
      initialize = resolve;
    });
  });
  const tool = createBrowserChallengeHandler(
    context,
    "PREVIEW",
    undefined,
    factory,
    journal,
  );
  const pending = run(tool, "solve", controller.signal);
  await started;
  controller.abort(new Error("stopped"));
  await expect(pending).rejects.toThrow("stopped");
  initialize({ solve });
  await Promise.resolve();
  expect(solve).not.toHaveBeenCalled();
  expect(onToolCost).not.toHaveBeenCalled();
  expect(evaluate).toHaveBeenCalledTimes(1);
});

it.each([
  "non-demo",
  "hcaptcha",
  "interstitial",
  "multiple widgets",
  "invisible",
  "foreign site key",
])(
  "hands off unsupported challenges without provider work: %s",
  async (variant) => {
    const { tool, solve, evaluate } = setup();
    const data = cloneObservation();
    if (variant === "non-demo") data.url = "https://customer.test/login";
    if (variant === "hcaptcha")
      (data.widgets[0] as { kind: string }).kind = "hcaptcha";
    if (variant === "interstitial") data.interstitial = true;
    if (variant === "multiple widgets")
      data.widgets.push({ ...data.widgets[0] });
    if (variant === "invisible") data.widgets[0].invisible = true;
    if (variant === "foreign site key")
      data.widgets[0].siteKey = "foreign-customer-key";
    evaluate.mockResolvedValue(data);
    await expect(run(tool, "solve")).resolves.toEqual({
      status: "handoff_required",
      reason: "unsupported_challenge",
      guidance: expect.any(String),
    });
    expect(solve).not.toHaveBeenCalled();
  },
);

it("uses the real solver adapter through HTTP polling and private browser delivery", async () => {
  jest.useFakeTimers();
  const { context, journal, evaluate, onToolCost } = setup();
  const fetch = jest.fn();
  global.fetch = fetch;
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ errorId: 0, taskId: 123 }),
  });
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      errorId: 0,
      status: "ready",
      solution: { gRecaptchaResponse: "private-response" },
      cost: "0.003",
    }),
  });
  const tool = createBrowserChallengeHandler(
    context,
    "PREVIEW",
    undefined,
    undefined,
    journal,
  );
  const pending = run(tool, "solve");
  await jest.advanceTimersByTimeAsync(5000);
  await expect(pending).resolves.toMatchObject({
    status: "token_delivered",
    websiteAccepted: false,
  });
  expect(onToolCost).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(journal.registerTask).toHaveBeenCalledWith(123);
  expect(journal.recordCost).toHaveBeenCalledWith(123, 0.003);
});
