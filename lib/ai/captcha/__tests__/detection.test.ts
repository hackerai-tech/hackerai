import {
  browserChallengeObservation,
  buildDeliverCaptchaScript,
  DETECT_CHALLENGES_SCRIPT,
  isCaptchaDemo,
  isSupportedCaptchaTarget,
} from "../detection";

const inspect = () =>
  browserChallengeObservation.parse(window.eval(DETECT_CHALLENGES_SCRIPT));
beforeEach(() => {
  document.body.innerHTML = "";
});

it("requires an exact server-approved URL, kind and site key for non-demo solving", () => {
  const widget = {
    kind: "hcaptcha" as const,
    siteKey: "public-widget-key",
    invisible: false,
    tokenPresent: false,
  };
  const url = "https://authorized.example.test/login";
  const configuration = JSON.stringify([
    { url, kind: widget.kind, siteKey: widget.siteKey },
  ]);
  expect(isSupportedCaptchaTarget(url, widget, configuration)).toBe(true);
  expect(isSupportedCaptchaTarget(url, widget, "")).toBe(false);
  expect(isSupportedCaptchaTarget(url + "/other", widget, configuration)).toBe(
    false,
  );
  expect(
    isSupportedCaptchaTarget(
      url,
      { ...widget, siteKey: "unapproved-site-key" },
      configuration,
    ),
  ).toBe(false);
  expect(
    isSupportedCaptchaTarget(
      url,
      { ...widget, kind: "recaptcha_v2" },
      configuration,
    ),
  ).toBe(false);
});

it.each([
  "https://user:password@authorized.example.test/login",
  "https://authorized.example.test/login?token=private",
  "https://authorized.example.test/login#private",
  "http://authorized.example.test/login",
])("rejects credential-bearing or insecure target configuration: %s", (url) => {
  const widget = {
    kind: "hcaptcha" as const,
    siteKey: "public-widget-key",
    invisible: false,
    tokenPresent: false,
  };
  expect(
    isSupportedCaptchaTarget(
      url,
      widget,
      JSON.stringify([{ url, kind: widget.kind, siteKey: widget.siteKey }]),
    ),
  ).toBe(false);
});
afterEach(() => jest.restoreAllMocks());

it("distinguishes widgets from completed tokens without returning token values", () => {
  document.body.innerHTML = `<form><div class="g-recaptcha" data-sitekey="public-key"></div><textarea name="g-recaptcha-response"></textarea></form>
    <form><div class="h-captcha" data-sitekey="h-key"></div><textarea name="h-captcha-response">private-token</textarea></form>
    <div><div class="cf-turnstile" data-sitekey="cf-key"></div><input name="cf-turnstile-response"></div>`;
  const result = inspect();
  expect(result.widgets).toEqual([
    {
      kind: "recaptcha_v2",
      siteKey: "public-key",
      tokenPresent: false,
      invisible: false,
    },
    {
      kind: "hcaptcha",
      siteKey: "h-key",
      tokenPresent: true,
      invisible: false,
    },
    {
      kind: "turnstile",
      siteKey: "cf-key",
      tokenPresent: false,
      invisible: false,
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it("detects interstitials without treating ordinary verification text as a challenge", () => {
  document.body.innerHTML = "<h1>How CAPTCHA verification works</h1>";
  expect(inspect()).toMatchObject({ widgets: [], interstitial: false });
  document.body.innerHTML = '<form id="challenge-form"></form>';
  expect(inspect()).toMatchObject({ widgets: [], interstitial: true });
});

it("delivers to the observed widget and callback without claiming website acceptance", () => {
  document.body.innerHTML =
    '<form><div class="g-recaptcha" data-sitekey="public-key" data-callback="captchaDone"></div><textarea name="g-recaptcha-response"></textarea></form>';
  const callback = jest.fn();
  Object.assign(window, { captchaDone: callback });
  const observation = inspect();
  const result = window.eval(
    buildDeliverCaptchaScript(
      observation,
      observation.widgets[0],
      "sensitive-response",
    ),
  );
  expect(result).toEqual({ status: "token_delivered", websiteAccepted: false });
  expect(
    (document.querySelector("textarea") as HTMLTextAreaElement).value,
  ).toBe("sensitive-response");
  expect(callback).toHaveBeenCalledWith("sensitive-response");
  expect(JSON.stringify(result)).not.toContain("sensitive-response");
  delete (window as unknown as Record<string, unknown>).captchaDone;
});

it("delivers an hCaptcha response to its own field without exposing it in results", () => {
  document.body.innerHTML =
    '<form><div class="h-captcha" data-sitekey="h-key"></div><textarea name="h-captcha-response"></textarea></form>';
  const observation = inspect();
  const result = window.eval(
    buildDeliverCaptchaScript(
      observation,
      observation.widgets[0],
      "private-h-response",
    ),
  );
  expect(result).toEqual({ status: "token_delivered", websiteAccepted: false });
  expect(
    (document.querySelector("textarea") as HTMLTextAreaElement).value,
  ).toBe("private-h-response");
  expect(JSON.stringify(result)).not.toContain("private-h-response");
});

it.each(["navigation", "document", "widget", "already completed"])(
  "does not deliver into a changed page: %s",
  (change) => {
    document.body.innerHTML =
      '<form><div class="g-recaptcha" data-sitekey="public-key"></div><textarea name="g-recaptcha-response"></textarea></form>';
    const observation = inspect();
    if (change === "navigation") observation.url = "https://example.com/";
    if (change === "document") observation.documentId = "previous-document";
    if (change === "widget")
      document
        .querySelector(".g-recaptcha")!
        .setAttribute("data-sitekey", "new-key");
    if (change === "already completed")
      (document.querySelector("textarea") as HTMLTextAreaElement).value =
        "human-solved";
    expect(
      window.eval(
        buildDeliverCaptchaScript(
          observation,
          observation.widgets[0],
          "must-not-deliver",
        ),
      ),
    ).toEqual({ status: "page_changed" });
    expect(
      (document.querySelector("textarea") as HTMLTextAreaElement).value,
    ).not.toBe("must-not-deliver");
  },
);

it.each([
  "https://www.google.com.evil.test/recaptcha/api2/demo",
  "https://www.google.com/recaptcha/api2/demo?token=private",
  "https://user:password@www.google.com/recaptcha/api2/demo",
  "http://www.google.com/recaptcha/api2/demo",
  "https://customer.test/login",
])("rejects non-demo or credential-bearing destinations: %s", (url) => {
  expect(isCaptchaDemo(url)).toBe(false);
});
