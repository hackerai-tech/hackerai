import {
  browserChallengeObservation,
  buildDeliverCaptchaScript,
  DETECT_CHALLENGES_SCRIPT,
} from "../detection";

const page = window as unknown as Record<string, unknown>;
const id = "steam_widget";
const siteKey = "public-site-key-1234";
const token = "synthetic-private-provider-response";
const inspect = () =>
  browserChallengeObservation.parse(window.eval(DETECT_CHALLENGES_SCRIPT));

function render() {
  document.body.innerHTML = `<div id="explicit-widget">
    <iframe src="https://newassets.hcaptcha.com/captcha/v1/version/static/hcaptcha.html#frame=checkbox&id=${id}&sitekey=${siteKey}"></iframe>
    <textarea id="h-captcha-response-${id}" name="h-captcha-response"></textarea>
    <textarea id="g-recaptcha-response-${id}" name="g-recaptcha-response"></textarea>
  </div>`;
  const frame = document.querySelector("iframe")!;
  jest.spyOn(frame, "getBoundingClientRect").mockReturnValue({
    width: 300,
    height: 78,
  } as DOMRect);
  const field = document.querySelector<HTMLTextAreaElement>(
    '[name="h-captcha-response"]',
  )!;
  const compatibilityField = document.querySelector<HTMLTextAreaElement>(
    '[name="g-recaptcha-response"]',
  )!;
  const getResponse = jest.fn((widgetId?: string) =>
    widgetId === id ? "" : "different-native-response",
  );
  const reset = jest.fn((_widgetId?: string) => {});
  const remove = jest.fn((_widgetId?: string) => {});
  const api = { getResponse, reset, remove };
  page.hcaptcha = api;
  return { frame, field, compatibilityField, api, getResponse, reset, remove };
}

afterEach(() => {
  (
    page.hcaptcha as { reset?: (widgetId?: string) => void } | undefined
  )?.reset?.(id);
  document.body.innerHTML = "";
  delete page.hcaptcha;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("discovers an explicitly rendered widget without data-sitekey, including completed responses", () => {
  const { field } = render();
  expect(document.querySelector("[data-sitekey]")).toBeNull();
  expect(inspect().widgets).toEqual([
    expect.objectContaining({
      kind: "hcaptcha",
      siteKey,
      hcaptchaWidgetId: id,
      tokenPresent: false,
      invisible: false,
    }),
  ]);
  field.value = token;
  const completed = inspect();
  expect(completed.widgets[0].tokenPresent).toBe(true);
  expect(JSON.stringify(completed)).not.toContain(token);
});

it.each([
  "untrusted host",
  "insecure URL",
  "challenge frame",
  "missing field",
  "mismatched field",
  "duplicate field",
  "ambiguous key",
  "unknown SDK widget",
  "frozen SDK",
  "read-only getter",
])("does not offer an unbound or ambiguous iframe widget: %s", (change) => {
  const { frame, field, getResponse, api } = render();
  if (change === "untrusted host")
    frame.src = frame.src.replace(
      "newassets.hcaptcha.com",
      "hcaptcha.com.evil.test",
    );
  if (change === "insecure URL")
    frame.src = frame.src.replace("https:", "http:");
  if (change === "challenge frame")
    frame.src = frame.src.replace("frame=checkbox", "frame=challenge");
  if (change === "missing field") field.remove();
  if (change === "mismatched field") field.id = "another-widget";
  if (change === "duplicate field") field.after(field.cloneNode());
  if (change === "ambiguous key") frame.src += "&sitekey=another-public-key";
  if (change === "unknown SDK widget")
    getResponse.mockImplementation(() => {
      throw Error("invalid widget");
    });
  if (change === "frozen SDK") Object.freeze(api);
  if (change === "read-only getter")
    Object.defineProperty(api, "getResponse", { writable: false });
  expect(inspect().widgets).toHaveLength(0);
});

it("keeps invisible frames ineligible and does not double-count standard widgets", () => {
  const { frame } = render();
  frame.style.display = "none";
  expect(inspect().widgets[0].invisible).toBe(true);
  frame.style.display = "";
  const element = frame.parentElement!;
  element.className = "h-captcha";
  element.setAttribute("data-sitekey", siteKey);
  expect(inspect().widgets).toHaveLength(1);
  expect(inspect().widgets[0].hcaptchaWidgetId).toBeUndefined();
});

it("delivers to Steam-style form fields and the addressed public SDK getter without faking acceptance", () => {
  const { api, field, compatibilityField, getResponse } = render();
  const observation = inspect();
  const result = window.eval(
    buildDeliverCaptchaScript(observation, observation.widgets[0], token),
  );
  expect(result).toEqual({
    status: "token_delivered",
    websiteAccepted: false,
    responseRetained: true,
  });
  expect(field.value).toBe(token);
  expect(compatibilityField.value).toBe(token);
  expect(api.getResponse(id)).toBe(token);
  expect(api.getResponse("other-widget")).toBe("different-native-response");
  expect(api.getResponse()).toBe("different-native-response");
  // The normal post-solve snapshot must not invalidate the delivered SDK response.
  expect(inspect().widgets[0].tokenPresent).toBe(true);
  expect(api.getResponse(id)).toBe(token);
  expect(api.getResponse).not.toBe(getResponse);
  expect(JSON.stringify(result)).not.toContain(token);
});

it.each([
  "frame",
  "field",
  "compatibility field",
  "sitekey",
  "already completed",
  "form replacement",
])("refuses delivery after the observed widget changes: %s", (change) => {
  const { frame, field, compatibilityField, api, getResponse } = render();
  const observation = inspect();
  if (change === "frame") {
    const replacement = frame.cloneNode() as HTMLIFrameElement;
    jest
      .spyOn(replacement, "getBoundingClientRect")
      .mockReturnValue({ width: 300, height: 78 } as DOMRect);
    frame.replaceWith(replacement);
  }
  if (change === "field") field.replaceWith(field.cloneNode());
  if (change === "compatibility field")
    compatibilityField.replaceWith(compatibilityField.cloneNode());
  if (change === "sitekey")
    frame.src = frame.src.replace(siteKey, "replacement-public-key");
  if (change === "already completed") field.value = "native-human-response";
  if (change === "form replacement") {
    const form = document.createElement("form");
    document.body.append(form);
    form.append(frame.parentElement!);
  }
  expect(
    window.eval(
      buildDeliverCaptchaScript(observation, observation.widgets[0], token),
    ),
  ).toEqual({ status: "page_changed" });
  expect(api.getResponse).toBe(getResponse);
  expect(field.value).not.toBe(token);
});

it.each(["reset", "remove", "field replacement", "native response", "expiry"])(
  "stops supplying the external response after %s",
  (change) => {
    jest.useFakeTimers();
    const { api, field, compatibilityField, getResponse, reset, remove } =
      render();
    const observation = inspect();
    window.eval(
      buildDeliverCaptchaScript(observation, observation.widgets[0], token),
    );
    if (change === "reset") api.reset(id);
    if (change === "remove") api.remove(id);
    if (change === "field replacement") field.replaceWith(field.cloneNode());
    if (change === "native response") {
      field.value = "native-human-response";
      compatibilityField.value = "native-human-response";
    }
    if (change === "expiry") jest.advanceTimersByTime(120001);
    if (change === "expiry") {
      // Cleanup must happen even when the application never calls the getter.
      expect(field.value).toBe("");
      expect(compatibilityField.value).toBe("");
      expect(api.getResponse).toBe(getResponse);
    }
    expect(api.getResponse(id)).toBe("");
    expect(api.getResponse).toBe(getResponse);
    expect(api.reset).toBe(reset);
    expect(api.remove).toBe(remove);
    if (change === "native response")
      expect(field.value).toBe("native-human-response");
  },
);

it("removes the response after DOM replacement without waiting for a getter call", async () => {
  const { api, field, compatibilityField, getResponse } = render();
  const observation = inspect();
  window.eval(
    buildDeliverCaptchaScript(observation, observation.widgets[0], token),
  );
  field.replaceWith(document.createElement("textarea"));
  await Promise.resolve();
  expect(api.getResponse).toBe(getResponse);
  expect(compatibilityField.value).toBe("");
});

it("keeps other widgets' reset/remove and later API replacements independent", () => {
  jest.useFakeTimers();
  const { api, field } = render();
  const observation = inspect();
  window.eval(
    buildDeliverCaptchaScript(observation, observation.widgets[0], token),
  );
  api.reset("other-widget");
  api.remove("other-widget");
  expect(api.getResponse(id)).toBe(token);
  const replacement = jest.fn(() => "new-native-response");
  api.getResponse = replacement;
  jest.advanceTimersByTime(120001);
  expect(api.getResponse).toBe(replacement);
  expect(field.value).toBe("");
});

it("reports a lost response if an application listener resets the widget during delivery", () => {
  const { api, field } = render();
  field.addEventListener("input", () => api.reset(id));
  const observation = inspect();
  expect(
    window.eval(
      buildDeliverCaptchaScript(observation, observation.widgets[0], token),
    ),
  ).toMatchObject({
    status: "token_delivered",
    responseRetained: false,
    websiteAccepted: false,
  });
  expect(api.getResponse(id)).toBe("");
});
