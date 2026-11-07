/** @jest-environment-options {"url":"https://managed.example/challenge"} */
import {
  cloudflareInitScript,
  cloudflarePreviewUrls,
  cloudflarePageUrl,
  cloudflareOutcomeScript,
  cloudflareReleaseScript,
} from "../cloudflare";
import { createBrowserChallengeHandler } from "../browser-challenge";
import type { ToolContext } from "@/types";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import {
  browserChallengeObservation,
  buildDeliverCaptchaScript,
  DETECT_CHALLENGES_SCRIPT,
  isSupportedCaptchaTarget,
} from "../detection";

jest.mock("@/lib/posthog/server", () => ({
  getPostHogBooleanFlagDecisionForUser: jest.fn(async () => true),
  phLogger: { event: jest.fn() },
}));

const key = Symbol.for("hackerai.cloudflareChallenge");
const page = window as unknown as Record<string | symbol, unknown>;
const inspect = () =>
  browserChallengeObservation.parse(window.eval(DETECT_CHALLENGES_SCRIPT));
const originalEnv = process.env;
beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(true);
  document.body.innerHTML = "";
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete page[key];
  delete page.turnstile;
  delete page[Symbol.for("hackerai.cloudflareInit")];
  process.env = originalEnv;
});

function render() {
  window.eval(cloudflareInitScript([location.href]));
  const original = jest.fn(
    (_container?: unknown, _options?: unknown) => "ordinary-widget",
  );
  const callback = jest.fn();
  const api = { render: original };
  page.turnstile = api;
  jest.advanceTimersByTime(10);
  const options = {
    sitekey: "0x4-public-site-key",
    action: "managed",
    cData: "opaque-data",
    chlPageData: "opaque-page-data",
    callback,
  };
  api.render(document.body, options);
  return { api, options, original, callback };
}

it.each([
  "cleared",
  "replaced",
  "detached",
  "stop",
  "declined",
  "declined-detached",
])(
  "verifies the actual managed outcome and restores a new challenge without another solve: %s",
  async (outcome) => {
    const { api, options, callback, original } = render();
    document.body.innerHTML = "<h2>Performing security verification</h2>";
    callback.mockImplementation(() => {
      if (outcome === "cleared")
        document.body.innerHTML =
          '<form><h1>Sign in</h1><input type="password"></form>';
      else {
        const container = document.createElement("div");
        document.body.append(container);
        api.render(container, options);
        if (outcome === "detached") container.remove();
      }
    });
    process.env = {
      ...originalEnv,
      HACKERAI_ENVIRONMENT: "preview",
      HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
      HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW: "1",
      CAPTCHA_SOLVER_PREVIEW_USER_IDS: "qa-user",
      CAPTCHA_CLOUDFLARE_PREVIEW_URLS: JSON.stringify([location.href]),
      TWOCAPTCHA_API_KEY: "private-key",
    };
    const solve = jest.fn(async () => ({
      token: "private-token",
      costDollars: 0.00145,
      userAgent: "solver-browser",
    }));
    const onToolCost = jest.fn();
    const context = {
      userID: "qa-user",
      triggerRunId: "test-run",
      onToolCost,
      browserSessions: {
        getChallengeBrowser: async () => ({
          identity: "owner",
          evaluate: async (script: string) => window.eval(script),
          deliverCloudflare: async (
            _ua: string,
            _page: unknown,
            script: string,
          ) => window.eval(script),
        }),
      },
    } as unknown as ToolContext;
    const journal = {
      reserve: jest.fn(async () => true),
      registerTask: jest.fn(),
      recordCost: jest.fn(),
    };
    const handler = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      () => ({ solve }),
      journal,
    );
    const controller = new AbortController();
    expect(
      await handler.inspect(undefined, {
        sandbox: {} as never,
        sessionName: "owned",
      }),
    ).toMatchObject({ status: "solve_available", providerTaskCreated: false });
    expect(solve).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
    if (outcome.startsWith("declined")) {
      if (outcome === "declined-detached")
        document.body.replaceWith(document.createElement("body"));
      expect(await handler.request("release", "owned")).toMatchObject({
        status: outcome === "declined" ? "released" : "release_skipped",
        manualWidgetRestored: outcome === "declined",
      });
      expect(page[key]).toBeUndefined();
      expect(original).toHaveBeenCalledTimes(outcome === "declined" ? 1 : 0);
      expect(solve).not.toHaveBeenCalled();
      expect(journal.reserve).not.toHaveBeenCalled();
      return;
    }
    const pending = handler.request("solve", "owned", controller.signal);
    const resultPromise = pending.catch((error) => error);
    if (outcome === "stop") {
      await jest.advanceTimersByTimeAsync(1);
      controller.abort(new Error("stopped"));
    }
    await jest.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;
    if (outcome === "stop") {
      expect(result).toEqual(new Error("stopped"));
      expect(original).not.toHaveBeenCalled();
      expect(page[key]).toBeDefined();
      expect(solve).toHaveBeenCalledTimes(1);
      expect(onToolCost).toHaveBeenCalledTimes(1);
      return;
    }
    if (outcome === "cleared") {
      expect(result).toMatchObject({
        status: "token_delivered",
        managedGateCleared: true,
        websiteAccepted: false,
      });
      expect(original).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        status: "handoff_required",
        reason: "managed_gate_not_cleared",
        responseDelivered: true,
        manualWidgetRestored: outcome !== "detached",
      });
      if (outcome === "detached") expect(original).not.toHaveBeenCalled();
      else
        expect(original).toHaveBeenCalledWith(
          expect.any(HTMLDivElement),
          options,
        );
      expect(page[key]).toBeUndefined();
      await handler();
    }
    expect(handler.getReceiptPrompt()).toContain(
      `post-delivery check: ${outcome === "cleared" ? "cleared" : "pending"}`,
    );
    expect(solve).toHaveBeenCalledTimes(1);
    expect(onToolCost).toHaveBeenCalledTimes(1);
    expect(journal.reserve).toHaveBeenCalledTimes(1);
  },
);

it("does not inspect or release a different page during managed verification", async () => {
  const { original } = render();
  const other = "https://other.example/challenge";
  await expect(window.eval(cloudflareOutcomeScript(other))).resolves.toBe(
    "page_changed",
  );
  expect(window.eval(cloudflareReleaseScript([other]))).toBe(false);
  expect(original).not.toHaveBeenCalled();
  expect(page[key]).toBeDefined();
});

it("lets the vendor initialize its global before capturing the first managed render", () => {
  window.eval(cloudflareInitScript([location.href]));
  const original = jest.fn();
  // Match the real vendor's duplicate-load guard before it assigns the API.
  const vendorLoaded = !("turnstile" in window);
  if (vendorLoaded) page.turnstile = { render: original };
  expect(vendorLoaded).toBe(true);
  jest.advanceTimersByTime(10);
  const api = page.turnstile as {
    render: (element: unknown, options: unknown) => unknown;
  };
  api.render(document.body, {
    sitekey: "public-managed-key",
    action: "managed",
    cData: "opaque",
    chlPageData: "opaque-page",
    callback: jest.fn(),
  });
  expect(original).not.toHaveBeenCalled();
  expect(inspect().widgets[0]?.managed).toBeDefined();
});

it("captures a managed render before it runs and delivers only to its pinned callback once", () => {
  const { api, original, callback } = render();
  expect(original).not.toHaveBeenCalled();
  const observation = inspect();
  expect(observation).toMatchObject({
    interstitial: true,
    widgets: [
      {
        kind: "turnstile",
        managed: {
          action: "managed",
          data: "opaque-data",
          pagedata: "opaque-page-data",
        },
      },
    ],
  });
  expect(api.render(document.body, { sitekey: "ordinary-site-key" })).toBe(
    "ordinary-widget",
  );
  const script = buildDeliverCaptchaScript(
    observation,
    observation.widgets[0],
    "private-solution",
  );
  expect(window.eval(script)).toEqual({
    status: "token_delivered",
    websiteAccepted: false,
  });
  expect(callback).toHaveBeenCalledWith("private-solution");
  expect(window.eval(script)).toEqual({ status: "page_changed" });
  expect(callback).toHaveBeenCalledTimes(1);
});

it("does not deliver a solution after the managed challenge re-renders", () => {
  const { api, options, callback } = render();
  const observation = inspect();
  api.render(document.body, options);
  expect(
    window.eval(
      buildDeliverCaptchaScript(
        observation,
        observation.widgets[0],
        "old-solution",
      ),
    ),
  ).toEqual({ status: "page_changed" });
  expect(callback).not.toHaveBeenCalled();
});

it("restores the real widget for manual verification after an unsuccessful solve", () => {
  const { api, original, options } = render();
  const initialOptions = { ...options };
  const captured = page[key] as { release: () => void };
  options.callback = jest.fn();
  options.cData = "changed-page-data";
  captured.release();
  expect(original).toHaveBeenCalledWith(document.body, initialOptions);
  expect(api.render).toBe(original);
  expect(page[key]).toBeUndefined();
  jest.advanceTimersByTime(100);
  expect(api.render).toBe(original);
});

it("releases interception without replaying into a removed widget container", () => {
  const { api, original, options } = render();
  const container = document.createElement("div");
  document.body.append(container);
  api.render(container, options);
  const captured = page[key] as { release: () => void };
  container.remove();
  captured.release();
  expect(original).not.toHaveBeenCalled();
  expect(api.render).toBe(original);
  expect(page[key]).toBeUndefined();
});

it("stops intercepting a replacement API after releasing the earlier managed challenge", () => {
  const { options } = render();
  const captured = page[key] as { release: () => void };
  const replacement = {
    render: jest.fn(
      (_element?: unknown, _options?: unknown) => "manual-widget",
    ),
  };
  const originalReplacement = replacement.render;
  page.turnstile = replacement;
  jest.advanceTimersByTime(10);
  captured.release();
  expect(replacement.render(document.body, options)).toBe("manual-widget");
  expect(originalReplacement).toHaveBeenCalledWith(document.body, options);
  expect(page[key]).toBeUndefined();
});

it("captures a transient Cloudflare challenge URL without approving unrelated query data", () => {
  const original = location.href;
  try {
    history.replaceState(null, "", "?__cf_chl_rt_tk=opaque-challenge-address");
    const canonical = cloudflarePageUrl(location.href)!;
    expect(canonical).toBe(location.origin + location.pathname);
    window.eval(cloudflareInitScript([canonical]));
    const callback = jest.fn();
    page.turnstile = { render: jest.fn() };
    jest.advanceTimersByTime(10);
    (
      page.turnstile as {
        render: (element: unknown, options: unknown) => unknown;
      }
    ).render(document.body, {
      sitekey: "public-managed-key",
      action: "managed",
      cData: "opaque",
      chlPageData: "opaque-page",
      callback,
    });
    const observation = inspect();
    history.replaceState(null, "", canonical);
    expect(
      window.eval(
        buildDeliverCaptchaScript(
          observation,
          observation.widgets[0],
          "private-solution",
        ),
      ),
    ).toEqual({ status: "token_delivered", websiteAccepted: false });
    expect(callback).toHaveBeenCalledWith("private-solution");
    expect(cloudflarePageUrl(canonical + "?token=private")).toBeUndefined();
    expect(cloudflarePageUrl(canonical + "#private")).toBeUndefined();
  } finally {
    history.replaceState(null, "", original);
  }
});

it("restores the actual page widget when the handler rejects managed target approval", async () => {
  const { original, options } = render();
  process.env = {
    ...originalEnv,
    HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
    HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW: "1",
    CAPTCHA_SOLVER_PREVIEW_USER_IDS: "qa-user",
  };
  const solverFactory = jest.fn();
  const context = {
    userID: "qa-user",
    triggerRunId: "test-run",
    browserSessions: {
      getChallengeBrowser: async () => ({
        identity: "owner",
        evaluate: async (script: string) => window.eval(script),
      }),
    },
  } as unknown as ToolContext;
  const result = await createBrowserChallengeHandler(
    context,
    "PREVIEW",
    undefined,
    solverFactory,
  )();
  expect(result).toMatchObject({
    status: "handoff_required",
    reason: "unsupported_challenge",
  });
  expect(original).toHaveBeenCalledWith(document.body, options);
  expect(page[key]).toBeUndefined();
  expect(solverFactory).not.toHaveBeenCalled();
});

it.each(["disabled", "timeout", "unapproved page"])(
  "recovers an intercepted widget without provider work when rollout is unavailable: %s",
  async (reason) => {
    const { original, options } = render();
    process.env = {
      ...originalEnv,
      HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
      HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW: "1",
      CAPTCHA_SOLVER_PREVIEW_USER_IDS: "qa-user",
      CAPTCHA_CLOUDFLARE_PREVIEW_URLS: JSON.stringify([
        reason === "unapproved page" ? "https://other.example/" : location.href,
      ]),
    };
    const flag = jest.mocked(getPostHogBooleanFlagDecisionForUser);
    if (reason === "timeout") flag.mockReturnValue(new Promise(() => {}));
    else flag.mockResolvedValue(false);
    const solverFactory = jest.fn();
    const deliverCloudflare = jest.fn();
    const context = {
      userID: "qa-user",
      triggerRunId: "test-run",
      browserSessions: {
        getChallengeBrowser: async () => ({
          identity: "owner",
          evaluate: async (script: string) => window.eval(script),
          deliverCloudflare,
        }),
      },
    } as unknown as ToolContext;
    const pending = createBrowserChallengeHandler(
      context,
      "PREVIEW",
      undefined,
      solverFactory,
    )();
    if (reason === "timeout") await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    if (reason === "unapproved page") {
      expect(original).not.toHaveBeenCalled();
      expect(page[key]).toBeDefined();
    } else {
      expect(original).toHaveBeenCalledWith(document.body, options);
      expect(page[key]).toBeUndefined();
    }
    expect(solverFactory).not.toHaveBeenCalled();
    expect(deliverCloudflare).not.toHaveBeenCalled();
  },
);

it("leaves unapproved pages and ordinary Turnstile renders unchanged", () => {
  const api = { render: jest.fn() };
  page.turnstile = api;
  window.eval(cloudflareInitScript(["https://approved.example/sign-up"]));
  api.render();
  expect(api.render).toHaveBeenCalledTimes(1);
  expect(page[key]).toBeUndefined();
});

it("recognizes Cloudflare's current security challenge iframe without a data-sitekey container", () => {
  document.body.innerHTML =
    '<h2>Performing security verification</h2><iframe title="Widget containing a Cloudflare security challenge"></iframe>';
  expect(inspect()).toMatchObject({ interstitial: true, widgets: [] });
  document.body.innerHTML =
    '<form><div class="cf-turnstile" data-sitekey="public-site-key"><input name="cf-turnstile-response"><iframe title="Widget containing a Cloudflare security challenge"></iframe></div></form>';
  expect(inspect()).toMatchObject({
    interstitial: false,
    widgets: [{ kind: "turnstile" }],
  });
});

it("authorizes managed parameters only for the exact opt-in Preview URL", () => {
  render();
  const {
    widgets: [widget],
  } = inspect();
  const url = "https://dash.cloudflare.com/sign-up";
  process.env = {
    ...originalEnv,
    HACKERAI_ENVIRONMENT: "preview",
    CAPTCHA_CLOUDFLARE_PREVIEW_URLS: JSON.stringify([url]),
  };
  expect(cloudflarePreviewUrls("PREVIEW")).toEqual([url]);
  expect(isSupportedCaptchaTarget(url, widget)).toBe(true);
  expect(isSupportedCaptchaTarget(url + "/other", widget)).toBe(false);
  process.env.HACKERAI_ENVIRONMENT = "production";
  expect(cloudflarePreviewUrls("PRODUCTION")).toEqual([]);
  expect(isSupportedCaptchaTarget(url, widget)).toBe(false);
  process.env.CAPTCHA_CLOUDFLARE_PREVIEW_URLS = JSON.stringify([
    url + "?private=data",
  ]);
  expect(cloudflarePreviewUrls("PREVIEW")).toEqual([]);
});
