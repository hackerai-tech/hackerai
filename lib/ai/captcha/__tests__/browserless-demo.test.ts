import {
  buildBrowserlessDemoQuery,
  runBrowserlessDemo,
} from "../browserless-demo";

const originalEnv = process.env;
const payload = { demo: "recaptcha", userId: "qa-user" };
const providerKey = "private-browserless-key-12345678901234567890";
const mockFetch = jest.fn();
const reply = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => data,
});

beforeEach(() => {
  process.env = {
    ...originalEnv,
    HACKERAI_ENVIRONMENT: "preview",
    HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
    CAPTCHA_SOLVER_PREVIEW_USER_IDS: "qa-user",
    HACKERAI_BROWSERLESS_PILOT: "1",
    BROWSERLESS_API_KEY: providerKey,
  };
  mockFetch.mockReset();
});
afterEach(() => {
  process.env = originalEnv;
  document.body.innerHTML = "";
  document.body.removeAttribute("data-browserless-demo-ready");
  sessionStorage.clear();
});

it.each(["PRODUCTION", "DEVELOPMENT"])(
  "cannot call Browserless from %s even with all gates and a key present",
  async (environment) => {
    await expect(
      runBrowserlessDemo(payload, environment, { fetch: mockFetch }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(mockFetch).not.toHaveBeenCalled();
  },
);

it.each(["gate", "user", "key", "runtime"])(
  "fails closed when the Preview %s is unavailable",
  async (missing) => {
    if (missing === "gate") delete process.env.HACKERAI_BROWSERLESS_PILOT;
    if (missing === "user")
      process.env.CAPTCHA_SOLVER_PREVIEW_USER_IDS = "other";
    if (missing === "key") delete process.env.BROWSERLESS_API_KEY;
    if (missing === "runtime") process.env.HACKERAI_ENVIRONMENT = "production";
    await expect(
      runBrowserlessDemo(payload, "PREVIEW", { fetch: mockFetch }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(mockFetch).not.toHaveBeenCalled();
  },
);

it("rejects arbitrary targets before any provider request", async () => {
  await expect(
    runBrowserlessDemo(
      { ...payload, url: "https://customer.example" },
      "PREVIEW",
      { fetch: mockFetch },
    ),
  ).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("recognizes the current GeeTest v4 demo markup before attempting a solve", () => {
  const query = buildBrowserlessDemoQuery("geetest");
  const script = query.match(
    /prepare: evaluate\(content: ("(?:\\.|[^"\\])*")\)/,
  )?.[1];
  if (!script) throw new Error("Missing demo preparation");
  document.body.innerHTML = '<div class="geetest_captcha"></div>';
  new Function("location", "document", "sessionStorage", JSON.parse(script))(
    { origin: "https://2captcha.com", pathname: "/demo/geetest-v4" },
    document,
    sessionStorage,
  );
  expect(document.body.getAttribute("data-browserless-demo-ready")).toBe("1");
});

it("submits a completed reCAPTCHA widget without unsupported Boolean exports", () => {
  const query = buildBrowserlessDemoQuery("recaptcha");
  const script = query.match(
    /submit: evaluate\(content: ("(?:\\.|[^"\\])*")\)/,
  )?.[1];
  if (!script) throw new Error("Missing demo submission");
  document.body.innerHTML =
    '<textarea name="g-recaptcha-response">test-response</textarea><button id="recaptcha-demo-submit">Submit</button>';
  const clicked = jest.fn();
  document.querySelector("button")!.addEventListener("click", clicked);
  new Function("location", "document", "sessionStorage", JSON.parse(script))(
    { origin: "https://www.google.com", pathname: "/recaptcha/api2/demo" },
    document,
    sessionStorage,
  );
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("browserless-demo-submitted")).toBe("1");
  sessionStorage.removeItem("browserless-demo-submitted");
});

it("recognizes Google's server-rendered verification success page", () => {
  const query = buildBrowserlessDemoQuery("recaptcha");
  const script = query.match(
    /outcome: evaluate\(content: ("(?:\\.|[^"\\])*")\)/,
  )?.[1];
  if (!script) throw new Error("Missing demo outcome");
  document.body.innerHTML =
    '<div class="recaptcha-success">Verification Success...</div>';
  sessionStorage.setItem("browserless-demo-submitted", "1");
  const result = new Function(
    "location",
    "document",
    "sessionStorage",
    JSON.parse(script),
  )(
    { origin: "https://www.google.com", pathname: "/recaptcha/api2/demo" },
    document,
    sessionStorage,
  );
  expect(JSON.parse(result)).toEqual({ submitted: true, accepted: true });
});

it.each([
  { origin: "https://www.google.com", response: "" },
  { origin: "https://other.example", response: "test-response" },
])("does not submit an incomplete widget or changed origin: %j", (state) => {
  const query = buildBrowserlessDemoQuery("recaptcha");
  const script = query.match(
    /submit: evaluate\(content: ("(?:\\.|[^"\\])*")\)/,
  )?.[1];
  if (!script) throw new Error("Missing demo submission");
  document.body.innerHTML =
    '<textarea name="g-recaptcha-response"></textarea><button id="recaptcha-demo-submit">Submit</button>';
  document.querySelector("textarea")!.value = state.response;
  const clicked = jest.fn();
  document.querySelector("button")!.addEventListener("click", clicked);
  new Function("location", "document", "sessionStorage", JSON.parse(script))(
    { origin: state.origin, pathname: "/recaptcha/api2/demo" },
    document,
    sessionStorage,
  );
  expect(clicked).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("browserless-demo-submitted")).toBeNull();
});

it("keeps the key in the provider auth header and requires website acceptance", async () => {
  mockFetch.mockResolvedValueOnce(
    reply({
      data: {
        attempt: {
          solve: {
            found: true,
            solved: true,
            time: 4000,
            token: "private-token",
          },
          outcome: {
            value: JSON.stringify({ submitted: true, accepted: true }),
          },
        },
      },
    }),
  );
  const result = await runBrowserlessDemo(payload, "PREVIEW", {
    fetch: mockFetch,
  });
  expect(result).toMatchObject({
    status: "completed",
    providerSolved: true,
    formSubmitted: true,
    websiteAccepted: true,
    controlOnly: false,
  });
  const [url, request] = mockFetch.mock.calls[0];
  expect(url).toBe(
    "https://production-sfo.browserless.io/stealth/bql?timeout=110000",
  );
  expect(request.headers.Authorization).toBe(`Bearer ${providerKey}`);
  expect(request.redirect).toBe("error");
  expect(request.body).not.toContain(providerKey);
  expect(JSON.stringify(result)).not.toContain("private-token");
  expect(JSON.stringify(result)).not.toContain(providerKey);
});

it.each([
  { submitted: true, accepted: false, solved: true },
  { submitted: false, accepted: true, solved: true },
  { submitted: true, accepted: true, solved: false },
])("does not confuse partial success with acceptance: %j", async (state) => {
  mockFetch.mockResolvedValueOnce(
    reply({
      data: {
        attempt: {
          solve: { found: true, solved: state.solved, time: 20 },
          outcome: { value: JSON.stringify(state) },
        },
      },
    }),
  );
  const result = await runBrowserlessDemo(payload, "PREVIEW", {
    fetch: mockFetch,
  });
  expect(result).toMatchObject({ websiteAccepted: false });
});

it("records missing observations and GraphQL partial failures without leaking errors", async () => {
  mockFetch.mockResolvedValueOnce(
    reply({
      data: { attempt: { solve: { found: true, solved: true, time: 100 } } },
      errors: [{ message: `${providerKey} private-token`, path: ["outcome"] }],
    }),
  );
  const result = await runBrowserlessDemo(payload, "PREVIEW", {
    fetch: mockFetch,
  });
  expect(result).toMatchObject({
    websiteAccepted: false,
    outcomeObserved: false,
    providerErrorCount: 1,
    failedStages: ["outcome"],
  });
  expect(JSON.stringify(result)).not.toContain(providerKey);
});

it("retains blocked-page evidence when the demo widget never loads", async () => {
  const screenshot = "iVBORw0KGgo=";
  mockFetch.mockResolvedValueOnce(
    reply({
      data: {
        goto: { status: 403 },
        attempt: null,
        image: { base64: screenshot },
      },
      errors: [{ message: "widget unavailable", path: ["widget"] }],
    }),
  );
  expect(
    await runBrowserlessDemo(payload, "PREVIEW", { fetch: mockFetch }),
  ).toMatchObject({
    navigationStatus: 403,
    challengeReady: false,
    websiteAccepted: false,
    screenshotPng: screenshot,
  });
});

it("labels the Turnstile demo as a test-key control even when accepted", async () => {
  mockFetch.mockResolvedValueOnce(
    reply({
      data: {
        attempt: {
          solve: { found: true, solved: true, time: 20 },
          outcome: {
            value: JSON.stringify({ submitted: true, accepted: true }),
          },
        },
      },
    }),
  );
  expect(
    await runBrowserlessDemo({ ...payload, demo: "turnstile" }, "PREVIEW", {
      fetch: mockFetch,
    }),
  ).toMatchObject({ controlOnly: true, websiteAccepted: true });
});

it("never retries an ambiguous provider failure or forwards provider diagnostics", async () => {
  mockFetch.mockRejectedValue(new Error(`${providerKey} private-token`));
  const result = await runBrowserlessDemo(payload, "PREVIEW", {
    fetch: mockFetch,
  });
  expect(result).toMatchObject({ status: "outcome_unknown" });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(providerKey);
});

it("does not start a provider request after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runBrowserlessDemo(payload, "PREVIEW", {
      fetch: mockFetch,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(mockFetch).not.toHaveBeenCalled();
});
