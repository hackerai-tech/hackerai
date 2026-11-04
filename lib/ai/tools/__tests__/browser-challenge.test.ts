import type { ToolContext } from "@/types";
import { createBrowserChallenge } from "../browser-challenge";
import { DETECT_CHALLENGES_SCRIPT } from "../../captcha/detection";
import { openBrowserlessFallback } from "../../captcha/browserless-session";

jest.mock("../../captcha/browserless-session", () => ({
  ...jest.requireActual("../../captcha/browserless-session"),
  openBrowserlessFallback: jest.fn(),
}));
jest.mock("../../captcha/browserless-tunnel", () => ({
  createBrowserlessTunnel: jest.fn(),
}));
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
      tokenPresent: false,
      invisible: false,
    },
  ],
  interstitial: false,
};
const originalEnv = process.env;
const originalFetch = global.fetch;
const cloneObservation = () => ({
  ...observation,
  widgets: observation.widgets.map((widget) => ({ ...widget })),
});
function setup(environment = "PREVIEW", overrides: Partial<ToolContext> = {}) {
  const adoptRemote = jest.fn(async () => {});
  const evaluate = jest.fn(async (script: string) =>
    script === DETECT_CHALLENGES_SCRIPT
      ? cloneObservation()
      : { status: "token_delivered" },
  );
  const getChallengeBrowser = jest.fn(async () => ({
    identity: "owner:default",
    evaluate,
    adoptRemote,
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
  const tool = createBrowserChallenge(context, environment, undefined, () => ({
    solve,
  }));
  return {
    tool,
    context,
    solve,
    evaluate,
    getChallengeBrowser,
    onToolCost,
    adoptRemote,
  };
}
const run = (
  tool: ReturnType<typeof createBrowserChallenge>,
  action: "inspect" | "solve",
  abortSignal?: AbortSignal,
) =>
  tool.execute!({ action }, { toolCallId: "test", messages: [], abortSignal });

beforeEach(() => {
  jest.clearAllMocks();
  flag.mockResolvedValue(true);
  process.env = {
    ...originalEnv,
    HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
    CAPTCHA_SOLVER_PREVIEW_USER_IDS: "internal-user",
    TWOCAPTCHA_API_KEY: "private-provider-key",
  };
  delete process.env.HACKERAI_BROWSERLESS_FALLBACK_PREVIEW;
  delete process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW;
});

it("automatically solves a detected supported challenge in place before considering a hosted browser", async () => {
  process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW = "1";
  process.env.HACKERAI_BROWSERLESS_FALLBACK_PREVIEW = "1";
  process.env.HACKERAI_ENVIRONMENT = "preview";
  const { tool, solve, adoptRemote, evaluate } = setup();
  evaluate.mockResolvedValueOnce({ ...cloneObservation(), widgets: [] });
  expect(await run(tool, "inspect")).toEqual({
    status: "no_pending_challenge",
  });
  expect(solve).not.toHaveBeenCalled();
  expect(await run(tool, "inspect")).toMatchObject({
    status: "token_delivered",
    websiteAccepted: false,
  });
  expect(adoptRemote).not.toHaveBeenCalled();
  expect(openBrowserlessFallback).not.toHaveBeenCalled();
  expect(await run(tool, "inspect")).toMatchObject({ reason: "attempt_limit" });
  expect(solve).toHaveBeenCalledTimes(1);
});

describe("on-demand Browserless fallback", () => {
  const open = jest.mocked(openBrowserlessFallback);
  let close: jest.Mock;
  beforeEach(() => {
    process.env.HACKERAI_BROWSERLESS_FALLBACK_PREVIEW = "1";
    process.env.HACKERAI_ENVIRONMENT = "preview";
    process.env.BROWSERLESS_API_KEY = "private-browserless-account-key";
    close = jest.fn(async () => {});
    open.mockReset().mockResolvedValue({
      close,
      expiresAt: Date.now() + 60000,
    } as unknown as Awaited<ReturnType<typeof openBrowserlessFallback>>);
  });

  it("does not allocate or switch browsers on a page without a pending CAPTCHA", async () => {
    const { tool, evaluate, adoptRemote } = setup();
    evaluate.mockResolvedValue({ ...cloneObservation(), widgets: [] });
    await expect(run(tool, "inspect")).resolves.toEqual({
      status: "no_pending_challenge",
    });
    expect(open).not.toHaveBeenCalled();
    expect(adoptRemote).not.toHaveBeenCalled();
  });

  it("adopts a solved browser once while requiring normal website verification", async () => {
    const { tool, adoptRemote } = setup();
    const result = await run(tool, "inspect");
    expect(result).toMatchObject({
      status: "browserless_fallback_ready",
      browserChanged: true,
      websiteAccepted: false,
    });
    expect(adoptRemote).toHaveBeenCalledWith(
      { url: observation.url, documentId: observation.documentId },
      expect.any(Function),
    );
    expect(close).not.toHaveBeenCalled();
    await expect(run(tool, "inspect")).resolves.toMatchObject({
      reason: "attempt_limit",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(
      process.env.BROWSERLESS_API_KEY,
    );
  });

  it.each(["provider", "adoption"])(
    "does not retry after an ambiguous %s failure",
    async (stage) => {
      const { tool, adoptRemote, solve } = setup();
      if (stage === "provider")
        open.mockRejectedValueOnce(new Error("private-provider-response"));
      else adoptRemote.mockRejectedValueOnce(new Error("stale ownership"));
      await expect(run(tool, "inspect")).resolves.toMatchObject({
        status: "handoff_required",
      });
      await expect(run(tool, "inspect")).resolves.toMatchObject({
        reason: "attempt_limit",
      });
      await expect(run(tool, "solve")).resolves.toMatchObject({
        reason: "attempt_limit",
      });
      expect(open).toHaveBeenCalledTimes(1);
      expect(solve).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(stage === "adoption" ? 1 : 0);
    },
  );

  it.each([
    "gate off",
    "wrong runtime",
    "foreign page",
    "invisible",
    "interstitial",
  ])("does not allocate for %s", async (reason) => {
    const { tool, evaluate } = setup();
    const value = cloneObservation();
    if (reason === "gate off")
      process.env.HACKERAI_BROWSERLESS_FALLBACK_PREVIEW = "0";
    if (reason === "wrong runtime")
      process.env.HACKERAI_ENVIRONMENT = "production";
    if (reason === "foreign page") value.url = "https://example.com/private";
    if (reason === "invisible") value.widgets[0].invisible = true;
    if (reason === "interstitial") value.interstitial = true;
    evaluate.mockResolvedValue(value);
    await run(tool, "inspect");
    expect(open).not.toHaveBeenCalled();
  });
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
    visionGuidance: expect.any(String),
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
  });
  await expect(run(tool, "solve")).resolves.toMatchObject({
    reason: "attempt_limit",
  });
  expect(solve).toHaveBeenCalledTimes(1);
});

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
    });
    expect(solve).not.toHaveBeenCalled();
  },
);

it("uses the real solver adapter through HTTP polling and private browser delivery", async () => {
  jest.useFakeTimers();
  const { context, evaluate, onToolCost } = setup();
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
  const tool = createBrowserChallenge(context, "PREVIEW");
  const pending = run(tool, "solve");
  await jest.advanceTimersByTimeAsync(5000);
  await expect(pending).resolves.toMatchObject({
    status: "token_delivered",
    websiteAccepted: false,
  });
  expect(onToolCost).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(2);
});
