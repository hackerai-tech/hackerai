import {
  cloudflareInitScript,
  cloudflarePreviewUrls,
  cloudflarePageUrl,
} from "../cloudflare";
import { createBrowserChallengeHandler } from "../browser-challenge";
import type { ToolContext } from "@/types";
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
