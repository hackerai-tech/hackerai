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
  expect(inspect().widgets).toEqual([
    expect.objectContaining({ hcaptchaWidgetId: id, invisible: false }),
  ]);
  element.setAttribute("data-size", "invisible");
  expect(inspect().widgets[0].invisible).toBe(true);
  // A container whose key does not match its SDK frame keeps the field path.
  element.setAttribute("data-sitekey", "another-public-key");
  expect(inspect().widgets).toEqual([
    expect.objectContaining({ siteKey: "another-public-key" }),
  ]);
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

// Normal data-sitekey markup as created by the public SDK: the container owns
// the checkbox frame and both ID-addressed response fields.
function renderDeclarative(callback?: string) {
  const sdk = render();
  const element = sdk.frame.parentElement!;
  element.className = "h-captcha";
  element.setAttribute("data-sitekey", siteKey);
  sdk.frame.setAttribute("data-hcaptcha-widget-id", id);
  if (callback) element.setAttribute("data-callback", callback);
  const form = document.createElement("form");
  document.body.append(form);
  form.append(element);
  sdk.getResponse.mockImplementation(() => "");
  return { ...sdk, element, form };
}

const deliver = () => {
  const observation = inspect();
  return window.eval(
    buildDeliverCaptchaScript(observation, observation.widgets[0], token),
  );
};

it("routes a normal SDK widget once so an ID-less form reader sees the response", () => {
  const { api, form } = renderDeclarative();
  let submitted: string | undefined;
  // Form guards commonly read only the SDK default instead of the hidden field.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitted = api.getResponse();
  });
  expect(inspect().widgets).toEqual([
    expect.objectContaining({ hcaptchaWidgetId: id, tokenPresent: false }),
  ]);
  expect(deliver()).toEqual({
    status: "token_delivered",
    websiteAccepted: false,
    responseRetained: true,
  });
  form.requestSubmit();
  expect(submitted).toBe(token);
  expect(api.getResponse(undefined)).toBe(token);
  expect(api.getResponse(null as unknown as string)).toBe(token);
  expect(api.getResponse("other-widget")).toBe("");
});

it("invokes a normal declarative callback once after the SDK default is available", () => {
  const { api, field } = renderDeclarative("onCaptcha");
  const seen: [string, string | undefined, string][] = [];
  page.onCaptcha = jest.fn((response: string) =>
    seen.push([response, api.getResponse(), field.value]),
  );
  try {
    expect(deliver()).toMatchObject({ status: "token_delivered" });
    expect(page.onCaptcha).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([[token, token, token]]);
  } finally {
    delete page.onCaptcha;
  }
});

it("keeps field-only delivery for a normal widget whose SDK cannot be adapted", () => {
  const { api, field, getResponse } = renderDeclarative();
  Object.freeze(api);
  expect(inspect().widgets[0].hcaptchaWidgetId).toBeUndefined();
  expect(deliver()).toMatchObject({ status: "token_delivered" });
  expect(field.value).toBe(token);
  expect(api.getResponse).toBe(getResponse);
});

it.each([
  "another container",
  "another response field",
  "another checkbox frame",
  "another widget's challenge",
  "mismatched container ID",
  "mismatched frame marker",
  "native default response",
  "native addressed response",
  "failing default getter",
])("never infers the SDK default widget with %s", (change) => {
  const { api, element, frame, getResponse } = renderDeclarative();
  if (change === "another container")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="h-captcha" data-sitekey="another-public-key"></div>',
    );
  if (change === "another response field")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<textarea name="h-captcha-response"></textarea>',
    );
  if (
    change === "another checkbox frame" ||
    change === "another widget's challenge"
  )
    document.body.insertAdjacentHTML(
      "beforeend",
      `<iframe src="https://newassets.hcaptcha.com/captcha/v1/version/static/hcaptcha.html#frame=${change === "another checkbox frame" ? "checkbox" : "challenge"}&id=other_widget&sitekey=${siteKey}"></iframe>`,
    );
  if (change === "mismatched container ID")
    element.setAttribute("data-hcaptcha-widget-id", "other_widget");
  if (change === "mismatched frame marker")
    frame.setAttribute("data-hcaptcha-widget-id", "other_widget");
  expect(deliver()).toMatchObject({ status: "token_delivered" });
  if (change === "native default response")
    getResponse.mockImplementation((widgetId?: string) =>
      widgetId === id ? "" : "different-native-response",
    );
  if (change === "native addressed response")
    getResponse.mockImplementation((widgetId?: string) =>
      widgetId === id ? "native-human-response" : "",
    );
  if (change === "failing default getter")
    getResponse.mockImplementation((widgetId?: string) => {
      if (widgetId == null) throw Error("no default widget");
      return "";
    });
  if (change === "failing default getter")
    expect(() => api.getResponse()).toThrow("no default widget");
  else
    expect(api.getResponse()).toBe(
      change === "native default response" ? "different-native-response" : "",
    );
  expect(api.getResponse(id)).toBe(token);
});

it.each(["second widget", "second response field"])(
  "revokes the SDK default when a %s appears, even after it is removed",
  async (change) => {
    const { api, field } = renderDeclarative();
    deliver();
    expect(api.getResponse()).toBe(token);
    const other = document.createElement("div");
    other.innerHTML =
      change === "second widget"
        ? `<iframe src="https://newassets.hcaptcha.com/captcha/v1/version/static/hcaptcha.html#frame=checkbox&id=other_widget&sitekey=${siteKey}"></iframe>`
        : '<textarea name="g-recaptcha-response"></textarea>';
    document.body.append(other);
    // The observer must revoke without waiting for a getter call.
    await Promise.resolve();
    other.remove();
    await Promise.resolve();
    expect(api.getResponse()).toBe("");
    // The explicitly addressed response keeps its other-widget semantics.
    expect(api.getResponse(id)).toBe(token);
    expect(field.value).toBe(token);
  },
);

it.each(["reset", "remove", "default reset", "SDK replacement", "expiry"])(
  "restores the native SDK default after %s",
  (change) => {
    jest.useFakeTimers();
    const { api, field, getResponse } = renderDeclarative();
    deliver();
    expect(api.getResponse()).toBe(token);
    if (change === "reset") api.reset(id);
    if (change === "remove") api.remove(id);
    if (change === "default reset") api.reset();
    if (change === "SDK replacement")
      page.hcaptcha = { getResponse: jest.fn(() => "") };
    if (change === "expiry") jest.advanceTimersByTime(120001);
    expect(api.getResponse()).toBe("");
    expect(api.getResponse).toBe(getResponse);
    expect(field.value).toBe("");
  },
);

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
