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

it.each(["valid", "missing", "null"])(
  "handles the managed request and required returned user agent: %s",
  async (variant) => {
    const previous = process.env;
    const url = "https://dash.cloudflare.com/sign-up";
    process.env = {
      ...previous,
      HACKERAI_ENVIRONMENT: "preview",
      CAPTCHA_CLOUDFLARE_PREVIEW_URLS: JSON.stringify([url]),
    };
    try {
      mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
      mockFetch.mockResolvedValueOnce(
        reply({
          errorId: 0,
          status: "ready",
          cost: "0.00145",
          solution: {
            token: "private-token",
            userAgent:
              variant === "valid"
                ? "solver-browser"
                : variant === "null"
                  ? null
                  : undefined,
          },
        }),
      );
      const recordCost = jest.fn(async () => {});
      const pending = createTwoCaptchaSolver("key").solve(
        url,
        {
          ...widget,
          kind: "turnstile",
          managed: {
            action: "managed",
            data: "opaque-data",
            pagedata: "opaque-page-data",
            userAgent: "original-browser",
          },
        },
        new AbortController().signal,
        undefined,
        recordCost,
      );
      const checked =
        variant === "valid"
          ? expect(pending).resolves.toEqual({
              token: "private-token",
              costDollars: 0.00145,
              userAgent: "solver-browser",
            })
          : expect(pending).rejects.toThrow("invalid solution");
      await jest.advanceTimersByTimeAsync(5000);
      await checked;
      expect(recordCost).toHaveBeenCalledTimes(1);
      expect(recordCost).toHaveBeenCalledWith(123, 0.00145);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).task).toEqual({
        type: "TurnstileTaskProxyless",
        websiteURL: url,
        websiteKey: widget.siteKey,
        action: "managed",
        data: "opaque-data",
        pagedata: "opaque-page-data",
        userAgent: "original-browser",
      });
    } finally {
      process.env = previous;
    }
  },
);

it.each(["control character", "oversized"])(
  "rejects an invalid managed request user agent before paid creation: %s",
  async (variant) => {
    const previous = process.env;
    const url = "https://dash.cloudflare.com/sign-up";
    process.env = {
      ...previous,
      HACKERAI_ENVIRONMENT: "preview",
      CAPTCHA_CLOUDFLARE_PREVIEW_URLS: JSON.stringify([url]),
    };
    try {
      await expect(
        createTwoCaptchaSolver("key").solve(
          url,
          {
            ...widget,
            kind: "turnstile",
            managed: {
              action: "managed",
              data: "opaque",
              pagedata: "opaque-page",
              userAgent:
                variant === "oversized" ? "x".repeat(1025) : "invalid\nagent",
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("unsupported");
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  },
);

beforeEach(() => {
  jest.useFakeTimers();
  // Node's native AbortSignal.timeout does not use Jest's fake clock.
  jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(new DOMException("Deadline expired", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  global.fetch = mockFetch;
  mockFetch.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["recaptcha_v2", "turnstile", "hcaptcha"] as const)(
  "creates once, polls and validates a %s solution",
  async (kind) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    mockFetch.mockResolvedValueOnce(
      reply({
        errorId: 0,
        status: "processing",
        cost: "",
        solution: { token: "", gRecaptchaResponse: null, userAgent: null },
      }),
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

it.each(["network", "http_503", "http_429", "body_timeout"])(
  "recovers a transient %s poll using the same paid task",
  async (failure) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    if (failure === "body_timeout") {
      mockFetch.mockImplementationOnce(async (_url, options) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            ),
          ),
      }));
    } else if (failure === "network")
      mockFetch.mockRejectedValueOnce(new Error("private transport failure"));
    else
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: failure === "http_503" ? 503 : 429,
      });
    mockFetch.mockResolvedValueOnce(
      reply({
        errorId: 0,
        status: "ready",
        cost: "0.00299",
        solution: { gRecaptchaResponse: "response" },
      }),
    );
    const pending = createTwoCaptchaSolver("provider-key").solve(
      demo,
      widget,
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(
      failure === "body_timeout" ? 25_000 : 10_000,
    );
    await expect(pending).resolves.toEqual({
      token: "response",
      costDollars: 0.00299,
    });
    const calls = mockFetch.mock.calls;
    expect(calls.filter(([url]) => url.endsWith("/createTask"))).toHaveLength(
      1,
    );
    expect(
      calls
        .filter(([url]) => url.endsWith("/getTaskResult"))
        .map(([, options]) => JSON.parse(options.body).taskId),
    ).toEqual([123, 123]);
  },
);

it("bounds transient poll failures and never recreates the paid task", async () => {
  mockFetch
    .mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }))
    .mockRejectedValue(new Error("private-network-detail"));
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toThrow(
    "CAPTCHA result read failed.",
  );
  await jest.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(mockFetch.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
    "createTask",
    "getTaskResult",
    "getTaskResult",
    "getTaskResult",
  ]);
});

it("cancels a transient polling retry without another read", async () => {
  mockFetch
    .mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }))
    .mockRejectedValue(new Error("private-network-detail"));
  const controller = new AbortController();
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(5000);
  controller.abort(new Error("stopped"));
  await rejected;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(mockFetch).toHaveBeenCalledTimes(2);
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
  const rejected = expect(
    createTwoCaptchaSolver("provider-key").solve(
      demo,
      widget,
      new AbortController().signal,
      register,
    ),
  ).rejects.toThrow("journal unavailable");
  await jest.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(register).toHaveBeenCalledWith(123);
  expect(register).toHaveBeenCalledTimes(3);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("recovers a transient registration failure using the same paid task", async () => {
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  mockFetch.mockResolvedValueOnce(
    reply({
      errorId: 0,
      status: "ready",
      cost: "0.00299",
      solution: { gRecaptchaResponse: "response" },
    }),
  );
  const register = jest
    .fn()
    .mockRejectedValueOnce(new Error("transient"))
    .mockResolvedValue(undefined);
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    new AbortController().signal,
    register,
  );
  await jest.advanceTimersByTimeAsync(5500);
  await expect(pending).resolves.toEqual({
    token: "response",
    costDollars: 0.00299,
  });
  expect(register.mock.calls).toEqual([[123], [123]]);
  expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.2captcha.com/createTask",
    "https://api.2captcha.com/getTaskResult",
  ]);
});

it("stops registration retries when canceled and never polls or recreates", async () => {
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  const controller = new AbortController();
  const register = jest.fn().mockRejectedValue(new Error("transient"));
  const pending = createTwoCaptchaSolver("provider-key").solve(
    demo,
    widget,
    controller.signal,
    register,
  );
  const rejected = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(1);
  controller.abort(new Error("stopped"));
  await rejected;
  await jest.advanceTimersByTimeAsync(10000);
  expect(register).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each(["deadline", "stop"])(
  "bounds pending registration on %s without recreating or polling",
  async (end) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    const controller = new AbortController();
    let finishRegistration!: () => void;
    const register = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRegistration = resolve;
        }),
    );
    let failure: unknown;
    const pending = createTwoCaptchaSolver("provider-key")
      .solve(demo, widget, controller.signal, register)
      .catch((error) => {
        failure = error;
      });
    await jest.advanceTimersByTimeAsync(1);
    if (end === "stop") controller.abort(new Error("stopped"));
    await jest.advanceTimersByTimeAsync(end === "deadline" ? 180_000 : 1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe(
      end === "deadline" ? "TimeoutError" : "Error",
    );
    finishRegistration(); // The already-started idempotent write may still finish.
    await pending;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(register.mock.calls).toEqual([[123]]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);

it.each([{}, null, { gRecaptchaResponse: "" }, { gRecaptchaResponse: null }])(
  "records a known fee even if the returned token is invalid: %j",
  async (solution) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    mockFetch.mockResolvedValueOnce(
      reply({ errorId: 0, status: "ready", cost: "0.00299", solution }),
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
  },
);

it("accepts a slow hCaptcha result from the original task after three minutes", async () => {
  const started = Date.now();
  mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
  mockFetch.mockImplementation(async () =>
    reply(
      Date.now() - started < 210_000
        ? { errorId: 0, status: "processing" }
        : {
            errorId: 0,
            status: "ready",
            cost: "0.00299",
            solution: { gRecaptchaResponse: "response" },
          },
    ),
  );
  const recordCost = jest.fn(async () => {});
  const pending = createTwoCaptchaSolver("provider-key").solve(
    "https://accounts.hcaptcha.com/demo",
    {
      ...widget,
      kind: "hcaptcha",
      siteKey: "a5f74b19-9e45-40e0-b45d-47ff91b7a6c2",
    },
    new AbortController().signal,
    undefined,
    recordCost,
  );
  const result = expect(pending).resolves.toEqual({
    token: "response",
    costDollars: 0.00299,
  });
  await jest.advanceTimersByTimeAsync(210_000);
  await result;
  expect(
    mockFetch.mock.calls.filter(([url]) => url.endsWith("/createTask")),
  ).toHaveLength(1);
  expect(recordCost).toHaveBeenCalledTimes(1);
});

it("Stop cancels slow hCaptcha polling without waiting for its longer deadline", async () => {
  mockFetch
    .mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }))
    .mockResolvedValue(reply({ errorId: 0, status: "processing" }));
  const controller = new AbortController();
  const pending = createTwoCaptchaSolver("provider-key").solve(
    "https://accounts.hcaptcha.com/demo",
    {
      ...widget,
      kind: "hcaptcha",
      siteKey: "a5f74b19-9e45-40e0-b45d-47ff91b7a6c2",
    },
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("stopped");
  await jest.advanceTimersByTimeAsync(200_000);
  const callsBeforeStop = mockFetch.mock.calls.length;
  controller.abort(new Error("stopped"));
  await rejected;
  await jest.advanceTimersByTimeAsync(100_000);
  expect(mockFetch).toHaveBeenCalledTimes(callsBeforeStop);
  expect(
    mockFetch.mock.calls.filter(([url]) => url.endsWith("/createTask")),
  ).toHaveLength(1);
});

it.each(["recaptcha_v2", "hcaptcha"] as const)(
  "bounds %s polling without issuing another paid creation",
  async (kind) => {
    mockFetch
      .mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }))
      .mockResolvedValue(reply({ errorId: 0, status: "processing" }));
    const pending = createTwoCaptchaSolver("provider-key").solve(
      kind === "hcaptcha" ? "https://accounts.hcaptcha.com/demo" : demo,
      kind === "hcaptcha"
        ? { ...widget, kind, siteKey: "a5f74b19-9e45-40e0-b45d-47ff91b7a6c2" }
        : widget,
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await jest.advanceTimersByTimeAsync(
      kind === "hcaptcha" ? 300_000 : 180_000,
    );
    await rejected;
    expect(
      mockFetch.mock.calls.filter(([url]) => url.endsWith("/createTask")),
    ).toHaveLength(1);
  },
);

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

it.each(["rejected", "slow", "stop", "deadline"])(
  "keeps a paid solution and cancellation independent of a %s cost journal write",
  async (outcome) => {
    mockFetch.mockResolvedValueOnce(reply({ errorId: 0, taskId: 123 }));
    mockFetch.mockResolvedValueOnce(
      reply({
        errorId: 0,
        status: "ready",
        solution: { gRecaptchaResponse: "private-response" },
        cost: "0.00145",
      }),
    );
    const controller = new AbortController();
    let finishWrite!: () => void;
    const recordCost = jest.fn(() =>
      outcome === "rejected"
        ? Promise.reject(new Error("journal unavailable"))
        : new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
    );
    let settled: unknown;
    const pending = createTwoCaptchaSolver("key")
      .solve(demo, widget, controller.signal, undefined, recordCost)
      .then(
        (value) => {
          settled = value;
        },
        (error) => {
          settled = error;
        },
      );
    try {
      await jest.advanceTimersByTimeAsync(5000);
      expect(recordCost).toHaveBeenCalledTimes(1);
      if (outcome === "stop" || outcome === "deadline")
        controller.abort(
          outcome === "stop"
            ? new Error("stopped")
            : new DOMException("deadline", "TimeoutError"),
        );
      await jest.advanceTimersByTimeAsync(outcome === "slow" ? 2001 : 1);
      if (outcome === "stop" || outcome === "deadline") {
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).name).toBe(
          outcome === "stop" ? "Error" : "TimeoutError",
        );
      } else
        expect(settled).toEqual({
          token: "private-response",
          costDollars: 0.00145,
        });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(recordCost).toHaveBeenCalledWith(123, 0.00145);
    } finally {
      finishWrite?.(); // An already-started idempotent write may finish later.
      await pending;
    }
  },
);
