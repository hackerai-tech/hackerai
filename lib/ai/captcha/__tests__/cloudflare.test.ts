import { cloudflareInitScript, cloudflarePreviewUrls } from "../cloudflare";
import {
  browserChallengeObservation,
  buildDeliverCaptchaScript,
  DETECT_CHALLENGES_SCRIPT,
  isSupportedCaptchaTarget,
} from "../detection";

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
