import { createTwoCaptchaSolver } from "../solver";
import type { CaptchaWidget } from "../detection";

const widget: CaptchaWidget = {
  kind: "recaptcha_v2",
  siteKey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
  observationId: "0123456789abcdef0123456789abcdef",
  tokenPresent: false,
  invisible: false,
};
const demo = "https://www.google.com/recaptcha/api2/demo";
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const reply = (data: unknown) => ({ ok: true, json: async () => data });

beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = mockFetch;
  mockFetch.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["recaptcha_v2", "turnstile", "hcaptcha"] as const)(
  "creates once, polls and validates a %s solution",
  async (kind) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    mockFetch.mockResolvedValueOnce(
      reply({ errorId: 0, status: "processing" }),
    );
    mockFetch.mockResolvedValueOnce(
      reply({
        errorId: 0,
        status: "ready",
        solution: { gRecaptchaResponse: "response", token: "response" },
        cost: "0.00299",
      }),
    );
    const url =
      kind === "turnstile"
        ? "https://2captcha.com/demo/cloudflare-turnstile"
        : kind === "hcaptcha"
          ? "https://accounts.hcaptcha.com/demo"
          : demo;
    const selectedWidget = {
      ...widget,
      kind,
      siteKey:
        kind === "turnstile"
          ? "3x00000000000000000000FF"
          : kind === "hcaptcha"
            ? "a5f74b19-9e45-40e0-b45d-47ff91b7a6c2"
            : widget.siteKey,
    };
    const onTaskCreated = jest.fn();
    const pending = createTwoCaptchaSolver("provider-key").solve(
      url,
      selectedWidget,
      new AbortController().signal,
      onTaskCreated,
    );
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({
      token: "response",
      costDollars: 0.00299,
    });
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.2captcha.com/createTask",
      "https://api.2captcha.com/getTaskResult",
      "https://api.2captcha.com/getTaskResult",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      task: {
        websiteURL: url,
        websiteKey: selectedWidget.siteKey,
        type:
          kind === "recaptcha_v2"
            ? "RecaptchaV2TaskProxyless"
            : kind === "hcaptcha"
              ? "HCaptchaTaskProxyless"
              : "TurnstileTaskProxyless",
      },
    });
    expect(onTaskCreated).toHaveBeenCalledWith(123);
  },
);

it("never retries an ambiguous paid creation failure or exposes provider errors", async () => {
  mockFetch.mockRejectedValue(new Error("provider-key sensitive-response"));
  await expect(
    createTwoCaptchaSolver("provider-key").solve(
      demo,
      widget,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Do not automatically retry");
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each([
  { errorId: 1, errorDescription: "provider-key" },
  { errorId: 0, status: "ready", solution: {}, cost: "0.003" },
  {
    errorId: 0,
    status: "ready",
    solution: { gRecaptchaResponse: "response" },
    cost: "NaN",
  },
  { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "response" } },
])(
  "rejects malformed or failed provider responses without token delivery",
  async (result) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    mockFetch.mockResolvedValueOnce(reply(result));
    const onTaskCreated = jest.fn();
    const pending = createTwoCaptchaSolver("provider-key").solve(
      demo,
      widget,
      new AbortController().signal,
      onTaskCreated,
    );
    const rejected = expect(pending).rejects.not.toThrow("provider-key");
    await jest.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(onTaskCreated).toHaveBeenCalledWith(123);
  },
);

it("cancels between task creation and polling without a further provider call", async () => {
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  const controller = new AbortController();
  const onTaskCreated = jest.fn();
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    controller.signal,
    onTaskCreated,
  );
  const rejected = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(1);
  controller.abort(new Error("stopped"));
  await rejected;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(onTaskCreated).toHaveBeenCalledWith(123);
});

it("awaits durable task registration and never creates again when registration fails", async () => {
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  const register = jest
    .fn()
    .mockRejectedValue(new Error("journal unavailable"));
  await expect(
    createTwoCaptchaSolver("provider-key").solve(
      demo,
      widget,
      new AbortController().signal,
      register,
    ),
  ).rejects.toThrow("journal unavailable");
  await jest.advanceTimersByTimeAsync(10000);
  expect(register).toHaveBeenCalledWith(123);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("records a known fee even if the returned token is invalid", async () => {
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  mockFetch.mockResolvedValueOnce(
    reply({ errorId: 0, status: "ready", cost: "0.00299", solution: {} }),
  );
  const recordCost = jest.fn(async () => {});
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    new AbortController().signal,
    undefined,
    recordCost,
  );
  const rejected = expect(pending).rejects.toThrow("invalid solution");
  await jest.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(recordCost).toHaveBeenCalledWith(123, 0.00299);
});

it("bounds polling without issuing another paid creation", async () => {
  mockFetch
    .mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }))
    .mockResolvedValue(reply({ errorId: 0, status: "processing" }));
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toThrow("timed out");
  await jest.advanceTimersByTimeAsync(175_000);
  await rejected;
  expect(
    mockFetch.mock.calls.filter(([url]) => url.endsWith("/createTask")),
  ).toHaveLength(1);
});

it.each([
  { url: "https://customer.test/login", widget },
  { url: demo, widget: { ...widget, kind: "hcaptcha" as const } },
  { url: demo, widget: { ...widget, invisible: true } },
  { url: demo, widget: { ...widget, siteKey: "foreign-customer-key" } },
])(
  "does not contact the provider outside supported public demos",
  async (input) => {
    await expect(
      createTwoCaptchaSolver("provider-key").solve(
        input.url,
        input.widget,
        new AbortController().signal,
      ),
    ).rejects.toThrow("unsupported");
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
