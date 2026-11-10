/** @jest-environment jsdom */
import {
  buildVisionCaptureScripts,
  visionScreenshotRequest,
} from "../vision-capture";

const siteKey = "public-site-key-for-fixture";
const scope = () => ({
  url: location.href,
  documentId: String(performance.timeOrigin),
  kind: "hcaptcha",
  siteKey,
});
function page() {
  document.body.innerHTML = `<div class="h-captcha" data-sitekey="${siteKey}"><textarea name="h-captcha-response"></textarea></div><iframe src="https://newassets.hcaptcha.com/captcha/v1/fixture/static/hcaptcha.html#frame=challenge&id=fixture"></iframe>`;
  const frame = document.querySelector("iframe")!;
  let y = -90;
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 1280 },
    innerHeight: { configurable: true, value: 720 },
  });
  frame.getBoundingClientRect = () => ({
    x: 400,
    y,
    width: 400,
    height: 900,
    left: 400,
    top: y,
    right: 800,
    bottom: y + 900,
    toJSON: () => ({}),
  });
  frame.scrollIntoView = jest.fn(() => {
    y = (innerHeight - 900) / 2;
  });
  document.elementFromPoint = jest.fn(() => frame);
  return frame;
}
afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

it("qualifies the full public challenge after viewport sizing without changing the puzzle", () => {
  const frame = page();
  const { prepareScript, measureScript } = buildVisionCaptureScripts(scope());
  expect(window.eval(prepareScript)).toMatchObject({
    status: "measured",
    fullyVisible: false,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 1024,
  });
  expect(window.eval(prepareScript)).toMatchObject({
    status: "measured",
    fullyVisible: true,
    frame: { y: 62, height: 900 },
  });
  jest.mocked(frame.scrollIntoView).mockClear();
  expect(window.eval(measureScript)).toMatchObject({ fullyVisible: true });
  expect(frame.scrollIntoView).not.toHaveBeenCalled();
  expect(document.querySelector("iframe")).toBe(frame);
});

it.each(["document", "second-widget", "token", "foreign-frame", "occluded"])(
  "refuses an unqualified capture: %s",
  (variant) => {
    const frame = page();
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 1024,
    });
    const expected = scope();
    if (variant === "document") expected.documentId = "other-document";
    if (variant === "second-widget")
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="h-captcha" data-sitekey="other-public-key"></div>`,
      );
    if (variant === "token")
      document.querySelector("textarea")!.value =
        "private-response-not-for-output";
    if (variant === "foreign-frame")
      frame.src =
        "https://hcaptcha.com.attacker.invalid/hcaptcha.html#frame=challenge";
    if (variant === "occluded")
      document.elementFromPoint = jest.fn(() => document.body);
    const result = window.eval(
      buildVisionCaptureScripts(expected).prepareScript,
    );
    expect(result.fullyVisible).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "private-response-not-for-output",
    );
  },
);

it("never serializes sandbox handles or private fields retained alongside a scope", () => {
  const extra = { ...scope(), sandbox: { apiKey: "PRIVATE_BACKEND_KEY" } };
  expect(JSON.stringify(buildVisionCaptureScripts(extra))).not.toMatch(
    /PRIVATE_BACKEND_KEY|sandbox|apiKey/,
  );
});

it.each([
  "agent-browser --session owned screenshot /tmp/image.png; echo extra",
  "agent-browser --session owned screenshot --full /tmp/image.png",
  "agent-browser --session owned screenshot /tmp/../secret.png",
  "agent-browser --session owned screenshot /etc/image.png",
  "echo agent-browser --session owned screenshot /tmp/image.png",
])("does not intercept an ambiguous screenshot command: %s", (command) => {
  expect(visionScreenshotRequest(command)).toBeUndefined();
});

it("keeps the ordinary named-session PNG screenshot contract", () => {
  expect(
    visionScreenshotRequest(
      "agent-browser --session owned screenshot /tmp/image.png",
    ),
  ).toEqual({ sessionName: "owned", path: "/tmp/image.png" });
});
