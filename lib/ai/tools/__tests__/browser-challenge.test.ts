import { CaptchaUnsolvableError } from "../../captcha/provider-error";
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
    process.env.HACKERAI_ENVIRONMENT = "preview";
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
      .mockResolvedValue("cleared");
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
        managedGateCleared: true,
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
      expect(evaluate).toHaveBeenCalledTimes(2);
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
  return action === "inspect"
    ? tool.inspect(abortSignal, { sandbox: {} as never, sessionName: "owned" })
    : tool(abortSignal);
};

beforeEach(() => {
  jest.clearAllMocks();
  flag.mockResolvedValue(true);
  process.env = {
    ...originalEnv,

    TWOCAPTCHA_API_KEY: "private-provider-key",
  };
});

it("loads solving only after the agent requests the detected session, once per run", async () => {
  const { tool, solve, solverFactory, journal } = setup();
  const target = { sandbox: {} as never, sessionName: "owned" };
  expect(await tool.request("solve", "owned")).toMatchObject({
    status: "snapshot_required",
  });
  expect(await tool.inspect(undefined, target)).toMatchObject({
    status: "solve_available",
    providerTaskCreated: false,
    providerCostUSD: 0,
  });
  expect(solverFactory).not.toHaveBeenCalled();
  expect(journal.reserve).not.toHaveBeenCalled();
  expect(await tool.request("solve", "foreign")).toMatchObject({
    status: "snapshot_required",
  });
  expect(await tool.request("solve", "owned")).toMatchObject({
    status: "token_delivered",
    providerTaskCreated: true,
    providerCostUSD: 0.003,
  });
  await tool.request("solve", "owned");
  expect(await tool.inspect(undefined, target)).toMatchObject({
    reason: "attempt_limit",
  });
  expect(solverFactory).toHaveBeenCalledTimes(1);
  expect(solve).toHaveBeenCalledTimes(1);
  expect(journal.reserve).toHaveBeenCalledTimes(1);
});

it("refuses a stale page decision without loading or charging the solver", async () => {
  const { tool, evaluate, solverFactory, journal } = setup();
  await tool.inspect(undefined, { sandbox: {} as never, sessionName: "owned" });
  evaluate.mockResolvedValueOnce({
    ...cloneObservation(),
    documentId: "replacement",
  });
  expect(await tool.request("solve", "owned")).toMatchObject({
    status: "page_changed",
  });
  expect(solverFactory).not.toHaveBeenCalled();
  expect(journal.reserve).not.toHaveBeenCalled();
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["STAGING", "DEVELOPMENT", "preview", "unknown"])(
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

it.each(["approval mode", "Ask mode"])(
  "preserves the eligibility boundary: %s",
  async (reason) => {
    const { tool, solve, getChallengeBrowser } = setup(
      "PREVIEW",
      reason === "approval mode"
        ? { requestToolApproval: jest.fn() }
        : reason === "Ask mode"
          ? { triggerRunId: undefined }
          : {},
    );
    await expect(run(tool, "solve")).resolves.toEqual({
      status: "unavailable",
    });
    expect(getChallengeBrowser).not.toHaveBeenCalled();
    expect(solve).not.toHaveBeenCalled();
  },
);

it("detects without spending, exposes no site key and respects a disabled flag", async () => {
  delete process.env.TWOCAPTCHA_API_KEY;
  const { tool, solve } = setup();
  await expect(run(tool, "inspect")).resolves.toMatchObject({
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
    delete process.env.TWOCAPTCHA_API_KEY;
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
    provider: "2captcha",
    providerTaskCreated: true,
    providerCostUSD: 0.003,
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
  const { tool, solve, evaluate } = setup();
  const pending = run(tool, "solve");
  await jest.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toEqual({ status: "unavailable" });
  expect(solve).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalledWith(DETECT_CHALLENGES_SCRIPT);
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

it("retains the same confirmed receipt after later snapshots without charging again", async () => {
  const { tool, evaluate, onToolCost } = setup();
  expect(tool.getReceiptPrompt()).toBe("");
  await run(tool, "solve");
  evaluate.mockResolvedValue({ ...cloneObservation(), widgets: [] });
  await expect(run(tool, "solve")).resolves.toMatchObject({
    status: "no_pending_challenge",
    provider: "2captcha",
    providerTaskCreated: true,
    providerCostUSD: 0.003,
  });
  const prompt = tool.getReceiptPrompt();
  expect(prompt).toContain("exactly one task");
  expect(prompt).toContain("0.003 USD");
  expect(prompt).toContain("delivery: delivered");
  expect(prompt).not.toMatch(
    /private-response|private-provider-key|google\.com/,
  );
  expect(onToolCost).toHaveBeenCalledTimes(1);
  expect(setup().tool.getReceiptPrompt()).toBe("");
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
  expect(phLogger.event).toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "canceled_while_solving" }),
  );
});

it("classifies Stop while waiting for the provider without retrying or delivering", async () => {
  const { tool, solve, evaluate, journal } = setup();
  const controller = new AbortController();
  const reason = new Error("private-stop-detail");
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  solve.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
        started();
      }),
  );
  const pending = run(tool, "solve", controller.signal);
  const rejected = expect(pending).rejects.toBe(reason);
  await waiting;
  controller.abort(reason);
  await rejected;
  expect(phLogger.event).toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "canceled_while_solving" }),
  );
  expect(phLogger.event).not.toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "provider_outcome_unknown" }),
  );
  expect(JSON.stringify(jest.mocked(phLogger.event).mock.calls)).not.toContain(
    "private-stop-detail",
  );
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(journal.reserve).toHaveBeenCalledTimes(1);
  await expect(run(tool, "solve")).resolves.toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
});

it("preserves delivery uncertainty when Stop races with response application", async () => {
  const { tool, evaluate } = setup();
  const controller = new AbortController();
  const reason = new Error("stopped during delivery");
  evaluate.mockImplementation(async (script) => {
    if (script === DETECT_CHALLENGES_SCRIPT) return cloneObservation();
    controller.abort(reason);
    throw reason;
  });
  await expect(run(tool, "solve", controller.signal)).rejects.toBe(reason);
  expect(phLogger.event).toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "delivery_outcome_unknown" }),
  );
  expect(phLogger.event).not.toHaveBeenCalledWith(
    "browser_captcha_solver_result",
    expect.objectContaining({ outcome: "canceled_while_solving" }),
  );
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

it.each(["interstitial", "multiple widgets", "invisible", "invalid site key"])(
  "hands off unsupported challenges without provider work: %s",
  async (variant) => {
    const { tool, solve, evaluate } = setup();
    const data = cloneObservation();
    if (variant === "interstitial") data.interstitial = true;
    if (variant === "multiple widgets")
      data.widgets.push({ ...data.widgets[0] });
    if (variant === "invisible") data.widgets[0].invisible = true;
    if (variant === "invalid site key") data.widgets[0].siteKey = "invalid key";
    evaluate.mockResolvedValue(data);
    await expect(run(tool, "solve")).resolves.toEqual({
      status: "handoff_required",
      reason: "unsupported_challenge",
      guidance: expect.any(String),
    });
    expect(solve).not.toHaveBeenCalled();
  },
);

it.each(["ready", "invalid solution", "poll failure", "ambiguous creation"])(
  "preserves confirmed provider facts through the real solver: %s",
  async (outcome) => {
    jest.useFakeTimers();
    const { context, journal, evaluate, onToolCost } = setup();
    const fetch = jest.fn();
    global.fetch = fetch;
    if (outcome === "ambiguous creation")
      fetch.mockRejectedValueOnce(new Error("private-provider-detail"));
    else
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errorId: 0, taskId: 123 }),
      });
    if (outcome !== "ambiguous creation")
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          outcome === "poll failure"
            ? { errorId: 1, errorCode: "ERROR_TASK_NOT_FOUND" }
            : {
                errorId: 0,
                status: "ready",
                solution:
                  outcome === "invalid solution"
                    ? {}
                    : { gRecaptchaResponse: "private-response" },
                cost: "0.003",
              },
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
    const result = await pending;
    expect(result).toMatchObject(
      outcome === "ready"
        ? { status: "token_delivered", websiteAccepted: false }
        : { status: "handoff_required", reason: "challenge_operation_failed" },
    );
    if (outcome === "ambiguous creation") {
      expect(result).not.toHaveProperty("providerTaskCreated");
      expect(journal.registerTask).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        provider: "2captcha",
        providerTaskCreated: true,
      });
      expect(journal.registerTask).toHaveBeenCalledWith(123);
    }
    if (outcome === "ready" || outcome === "invalid solution") {
      expect(result).toHaveProperty("providerCostUSD", 0.003);
      expect(journal.recordCost).toHaveBeenCalledWith(123, 0.003);
    } else {
      expect(result).not.toHaveProperty("providerCostUSD");
      expect(journal.recordCost).not.toHaveBeenCalled();
    }
    expect(onToolCost).toHaveBeenCalledTimes(
      outcome === "ready" || outcome === "invalid solution" ? 1 : 0,
    );
    expect(evaluate).toHaveBeenCalledTimes(outcome === "ready" ? 2 : 1);
    expect(fetch).toHaveBeenCalledTimes(
      outcome === "ambiguous creation" ? 1 : 2,
    );
  },
);

it.each(["PREVIEW", "PRODUCTION"])(
  "uses the single PostHog flag on ordinary sites in %s with only the API key",
  async (environment) => {
    process.env = { TWOCAPTCHA_API_KEY: "private-provider-key" };
    const { tool, evaluate, solve, solverFactory } = setup(environment);
    evaluate.mockResolvedValueOnce({
      ...cloneObservation(),
      url: "https://customer.test/login",
    });
    expect(
      await tool.inspect(undefined, {
        sandbox: {} as never,
        sessionName: "owned",
      }),
    ).toMatchObject({ status: "solve_available", providerTaskCreated: false });
    expect(flag).toHaveBeenCalledWith(
      "browser_captcha_solver_v1",
      "internal-user",
      undefined,
      { sendFeatureFlagEvents: false },
    );
    expect(solverFactory).not.toHaveBeenCalled();
    flag.mockResolvedValue(false);
    expect(await tool.request("solve", "owned")).toMatchObject({
      status: "unavailable",
    });
    expect(solve).not.toHaveBeenCalled();
  },
);

it.each(["same", "navigated", "other-owner", "invisible", "managed"])(
  "offers vision only after confirmed unsolvable in the same visible widget: %s",
  async (variant) => {
    const { tool, solve, evaluate, getChallengeBrowser, journal, onToolCost } =
      setup();
    const target = { sandbox: {} as never, sessionName: "owned" };
    await tool.inspect(undefined, target);
    solve.mockImplementation(async (...args: unknown[]) => {
      const register = args[3] as (id: number) => Promise<void>;
      await register!(123);
      if (variant === "navigated")
        evaluate.mockResolvedValue({
          ...cloneObservation(),
          documentId: "new-document",
        });
      if (variant === "invisible")
        evaluate.mockResolvedValue({
          ...cloneObservation(),
          widgets: [{ ...observation.widgets[0], invisible: true }],
        });
      if (variant === "managed")
        evaluate.mockResolvedValue({
          ...cloneObservation(),
          interstitial: true,
        });
      if (variant === "other-owner")
        getChallengeBrowser.mockResolvedValue({
          identity: "other-owner",
          evaluate,
        });
      throw new CaptchaUnsolvableError();
    });
    const result = await tool.request("solve", "owned");
    expect(result).toMatchObject({
      reason: "provider_unsolvable",
      visionFallbackAvailable: variant === "same",
      providerTaskCreated: true,
      providerCostUSD: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-provider-key|private-response/,
    );
    expect(onToolCost).toHaveBeenCalledWith(0);
    if (variant === "same") {
      expect(await tool.inspect(undefined, target)).toMatchObject({
        visionFallbackAvailable: true,
      });
      expect(await tool.request("solve", "owned")).toMatchObject({
        visionFallbackAvailable: false,
      });
    }
    await tool.inspect(undefined, target);
    await tool.request("solve", "owned");
    expect(solve).toHaveBeenCalledTimes(1);
    expect(journal.reserve).toHaveBeenCalledTimes(1);
  },
);

it("does not restart the vision deadline on another snapshot", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const { tool, solve } = setup();
    const target = { sandbox: {} as never, sessionName: "owned" };
    await tool.inspect(undefined, target);
    solve.mockImplementation(async (...args: unknown[]) => {
      const register = args[3] as (id: number) => Promise<void>;
      await register!(123);
      throw new CaptchaUnsolvableError();
    });
    expect(await tool.request("solve", "owned")).toMatchObject({
      visionDeadlineAt: 61000,
      visionFallbackAvailable: true,
    });
    now.mockReturnValue(61000);
    expect(await tool.inspect(undefined, target)).toMatchObject({
      reason: "vision_budget_exhausted",
      visionFallbackAvailable: false,
    });
    expect(solve).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});

it("carries a real solver error-12 result into same-page vision without injecting a response", async () => {
  jest.useFakeTimers();
  try {
    const { context, journal, evaluate } = setup();
    const data = {
      ...cloneObservation(),
      url: "https://store.steampowered.com/join/",
      widgets: [
        {
          ...observation.widgets[0],
          kind: "hcaptcha",
          hcaptchaWidgetId: "steam-widget",
        },
      ],
    };
    evaluate.mockResolvedValue(data as never);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errorId: 0, taskId: 123 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          errorId: 12,
          errorDescription: "private-provider-detail",
        }),
      });
    global.fetch = fetch;
    const tool = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      undefined,
      journal,
    );
    const target = { sandbox: {} as never, sessionName: "steam" };
    await tool.inspect(undefined, target);
    const pending = tool.request("solve", "steam");
    await jest.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      visionFallbackAvailable: true,
      providerCostUSD: 0,
      reason: "provider_unsolvable",
    });
    expect(await tool.inspect(undefined, target)).toMatchObject({
      visionFallbackAvailable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      evaluate.mock.calls.every(
        ([script]) => script === DETECT_CHALLENGES_SCRIPT,
      ),
    ).toBe(true);
    expect(journal.registerTask).toHaveBeenCalledWith(123);
    expect(journal.recordCost).not.toHaveBeenCalled(); // existing watchdog reconciles unsolvable, not "ready".
    expect(tool.getReceiptPrompt()).toContain("confirmed unsolvable");
  } finally {
    jest.useRealTimers();
    global.fetch = originalFetch;
  }
});

it("can release a vision recovery and never revive its paid offer", async () => {
  const { tool, solve, journal, evaluate } = setup();
  const target = { sandbox: {} as never, sessionName: "owned" };
  await tool.inspect(undefined, target);
  solve.mockImplementation(async (...args: unknown[]) => {
    await (args[3] as (id: number) => Promise<void>)(123);
    throw new CaptchaUnsolvableError();
  });
  await tool.request("solve", "owned");
  await tool.inspect(undefined, target);
  expect(await tool.request("release", "owned")).toMatchObject({
    status: "released",
  });
  expect(await tool.inspect(undefined, target)).toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
  expect(journal.reserve).toHaveBeenCalledTimes(1);
});

it("stops vision after another widget appears even if it disappears", async () => {
  const { tool, solve, evaluate } = setup();
  const target = { sandbox: {} as never, sessionName: "owned" };
  await tool.inspect(undefined, target);
  solve.mockImplementation(async (...args: unknown[]) => {
    await (args[3] as (id: number) => Promise<void>)(123);
    throw new CaptchaUnsolvableError();
  });
  await tool.request("solve", "owned");
  evaluate.mockResolvedValue({
    ...cloneObservation(),
    widgets: [
      ...observation.widgets,
      { ...observation.widgets[0], tokenPresent: true },
    ],
  } as never);
  expect(await tool.inspect(undefined, target)).toMatchObject({
    reason: "vision_page_changed",
    visionFallbackAvailable: false,
  });
  evaluate.mockResolvedValue(cloneObservation());
  expect(await tool.inspect(undefined, target)).toMatchObject({
    visionFallbackAvailable: false,
  });
  expect(
    tool.guardVisionCommand("agent-browser --session owned click @e1"),
  ).toMatchObject({ reason: "vision_budget_exhausted" });
  expect(solve).toHaveBeenCalledTimes(1);
});

it.each(["url", "documentId"])(
  "does not treat a different %s as vision completion",
  async (field) => {
    const { tool, solve, evaluate } = setup();
    const target = { sandbox: {} as never, sessionName: "owned" };
    await tool.inspect(undefined, target);
    solve.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as (id: number) => Promise<void>)(123);
      throw new CaptchaUnsolvableError();
    });
    await tool.request("solve", "owned");
    evaluate.mockResolvedValue({
      ...cloneObservation(),
      [field]:
        field === "url" ? "https://example.com/another-page" : "different",
      widgets: [],
    } as never);
    await tool.inspect(undefined, target);
    expect(
      tool.guardVisionCommand("agent-browser --session owned click @e1"),
    ).toMatchObject({ reason: "vision_budget_exhausted" });
    evaluate.mockResolvedValue(cloneObservation());
    expect(await tool.inspect(undefined, target)).toMatchObject({
      visionFallbackAvailable: false,
    });
    expect(solve).toHaveBeenCalledTimes(1);
  },
);

it("blocks expired recovery commands but permits observation, cleanup and verified completion", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const { tool, solve, evaluate } = setup();
    const target = { sandbox: {} as never, sessionName: "owned" };
    await tool.inspect(undefined, target);
    solve.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as (id: number) => Promise<void>)(123);
      throw new CaptchaUnsolvableError();
    });
    await tool.request("solve", "owned");
    expect(
      tool.guardVisionCommand(
        "agent-browser --session owned screenshot /tmp/image.png",
      ),
    ).toBeUndefined();
    now.mockReturnValue(61000);
    for (const command of [
      "agent-browser --session owned click @e1",
      "python3 crop.py",
      "agent-browser --session owned close; echo extra",
    ])
      expect(tool.guardVisionCommand(command)).toMatchObject({
        reason: "vision_budget_exhausted",
      });
    expect(
      tool.guardVisionCommand("agent-browser --session owned snapshot -i"),
    ).toBeUndefined();
    expect(
      tool.guardVisionCommand("agent-browser --session owned close"),
    ).toBeUndefined();
    expect(tool.getReceiptPrompt()).toContain(
      "Native vision seconds remaining: 0",
    );
    evaluate.mockResolvedValue({
      ...cloneObservation(),
      widgets: [{ ...observation.widgets[0], tokenPresent: true }],
    } as never);
    expect(await tool.inspect(undefined, target)).toMatchObject({
      status: "no_pending_challenge",
    });
    expect(
      tool.guardVisionCommand(
        "agent-browser --session owned eval document.title",
      ),
    ).toBeUndefined();
    evaluate.mockResolvedValue(cloneObservation());
    expect(await tool.inspect(undefined, target)).toMatchObject({
      reason: "vision_challenge_returned",
      visionFallbackAvailable: false,
    });
    expect(
      tool.guardVisionCommand("agent-browser --session owned click @e1"),
    ).toMatchObject({ reason: "vision_budget_exhausted" });
    evaluate.mockResolvedValue({
      ...cloneObservation(),
      widgets: [{ ...observation.widgets[0], tokenPresent: true }],
    } as never);
    await tool.inspect(undefined, target);
    expect(
      tool.guardVisionCommand("agent-browser --session owned click @submit"),
    ).toBeUndefined();
    evaluate.mockResolvedValue(cloneObservation());
    expect(await tool.inspect(undefined, target)).toMatchObject({
      reason: "vision_challenge_returned",
      visionFallbackAvailable: false,
    });
    tool.finishVisionCommand("agent-browser --session owned close", false);
    expect(tool.guardVisionCommand("ls")).toMatchObject({
      reason: "vision_budget_exhausted",
    });
    tool.finishVisionCommand("agent-browser --session owned close", true);
    expect(tool.guardVisionCommand("ls")).toBeUndefined();
    expect(solve).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});
