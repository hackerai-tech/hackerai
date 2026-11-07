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

const supportedWidget = {
  kind: "hcaptcha" as const,
  siteKey: "public-widget-key",
  invisible: false,
  observationId: "0123456789abcdef0123456789abcdef",
  tokenPresent: false,
};
it.each(["recaptcha_v2", "hcaptcha", "turnstile"] as const)(
  "supports an observed %s widget on a public page without target configuration",
  (kind) => {
    expect(
      isSupportedCaptchaTarget("https://customer.test/login", {
        ...supportedWidget,
        kind,
      }),
    ).toBe(true);
    expect(
      isSupportedCaptchaTarget("https://customer.test/login", {
        ...supportedWidget,
        siteKey: "invalid key",
      }),
    ).toBe(false);
  },
);
it.each([
  "https://user:password@customer.test/login",
  "https://customer.test/login?token=private",
  "https://customer.test/login#private",
  "http://customer.test/login",
  "not-a-url",
])("rejects credential-bearing or insecure destinations: %s", (url) => {
  expect(isSupportedCaptchaTarget(url, supportedWidget)).toBe(false);
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
      observationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      tokenPresent: false,
      invisible: false,
    },
    {
      kind: "hcaptcha",
      siteKey: "h-key",
      observationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      tokenPresent: true,
      invisible: false,
    },
    {
      kind: "turnstile",
      siteKey: "cf-key",
      observationId: expect.stringMatching(/^[a-f0-9]{32}$/),
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

it.each([
  "navigation",
  "document",
  "widget",
  "replacement",
  "response replacement",
  "already completed",
])("does not deliver into a changed page: %s", (change) => {
  document.body.innerHTML =
    '<form><div class="g-recaptcha" data-sitekey="public-key"></div><textarea name="g-recaptcha-response"></textarea></form>';
  const observation = inspect();
  if (change === "navigation") observation.url = "https://example.com/";
  if (change === "document") observation.documentId = "previous-document";
  if (change === "widget")
    document
      .querySelector(".g-recaptcha")!
      .setAttribute("data-sitekey", "new-key");
  if (change === "replacement") {
    const element = document.querySelector(".g-recaptcha")!;
    element.replaceWith(element.cloneNode(true));
  }
  if (change === "response replacement") {
    const field = document.querySelector("textarea")!;
    field.replaceWith(field.cloneNode(true));
  }
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
});

it.each([
  "https://www.google.com.evil.test/recaptcha/api2/demo",
  "https://www.google.com/recaptcha/api2/demo?token=private",
  "https://user:password@www.google.com/recaptcha/api2/demo",
  "http://www.google.com/recaptcha/api2/demo",
  "https://customer.test/login",
])("rejects non-demo or credential-bearing destinations: %s", (url) => {
  expect(isCaptchaDemo(url)).toBe(false);
});
