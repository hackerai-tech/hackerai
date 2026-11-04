import { z } from "zod";
import { isCaptchaPreviewEligible } from "./policy";

export const browserlessDemoPayload = z
  .object({
    demo: z.enum(["recaptcha", "hcaptcha", "turnstile", "geetest"]),
    userId: z.string().min(1),
  })
  .strict();

const demos = {
  recaptcha: {
    url: "https://www.google.com/recaptcha/api2/demo",
    widget: ".g-recaptcha",
    response: '[name="g-recaptcha-response"]',
    submit: "#recaptcha-demo-submit",
    success: '!!document.querySelector(".recaptcha-success")',
    type: "recaptcha",
    controlOnly: false,
  },
  hcaptcha: {
    url: "https://accounts.hcaptcha.com/demo",
    widget: ".h-captcha",
    response: '[name="h-captcha-response"]',
    submit: "#hcaptcha-demo-submit",
    success:
      '/Your hCaptcha token is valid|"success"\\s*:\\s*true/i.test(document.body.innerText)',
    // The BQL enum does not include hcaptcha; use its supported auto-detection.
    type: null,
    controlOnly: false,
  },
  turnstile: {
    url: "https://2captcha.com/demo/cloudflare-turnstile",
    widget: ".cf-turnstile",
    response: '[name="cf-turnstile-response"]',
    submit: null,
    success:
      'document.body.innerText.includes("Captcha is passed successfully!")',
    type: "cloudflare",
    // This public demo uses Cloudflare's published forced-challenge test key.
    controlOnly: true,
  },
  geetest: {
    url: "https://2captcha.com/demo/geetest-v4",
    widget: ".geetest_captcha",
    response: '[name="geetest_validate"], [name="captcha_output"]',
    submit: null,
    success:
      'document.body.innerText.includes("Captcha is passed successfully!")',
    type: "geetest",
    controlOnly: false,
  },
} as const;

const outcomeSchema = z.object({
  submitted: z.boolean(),
  accepted: z.boolean(),
});
const evaluationSchema = z.object({ value: z.string().max(4096) });
const responseSchema = z.object({
  data: z
    .object({
      goto: z.object({ status: z.number().nullable() }).nullish(),
      image: z.object({ base64: z.string().max(4_000_000) }).nullish(),
      attempt: z
        .object({
          solve: z
            .object({
              found: z.boolean().nullable(),
              solved: z.boolean().nullable(),
              time: z.number().finite().nonnegative().nullable(),
            })
            .nullish(),
          outcome: evaluationSchema.nullish(),
        })
        .nullish(),
    })
    .nullish(),
  errors: z
    .array(z.object({ path: z.array(z.unknown()).max(10).optional() }))
    .max(30)
    .optional(),
});

/** Fixed demo queries only: this is an internal evaluator, not an Agent transport. */
export function buildBrowserlessDemoQuery(
  demoName: z.infer<typeof browserlessDemoPayload>["demo"],
) {
  const demo = demos[demoName];
  const locationCheck = `location.origin + location.pathname === ${JSON.stringify(demo.url)}`;
  const prepare = `
    if (${locationCheck} && document.querySelector(${JSON.stringify(demo.widget)})) {
      document.body.setAttribute('data-browserless-demo-ready', '1');
      sessionStorage.removeItem('browserless-demo-submitted');
    }
    return true;
  `;
  const button = demo.submit
    ? `document.querySelector(${JSON.stringify(demo.submit)})`
    : `Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Check')`;
  const submit = `
    if (!(${locationCheck})) return false;
    const responsePresent = Array.from(document.querySelectorAll(${JSON.stringify(demo.response)}))
      .some(e => typeof e.value === 'string' && e.value.trim().length > 0);
    const completedWidget = ${demoName === "geetest" ? "!!document.querySelector('.geetest_success, .geetest4_success')" : "false"};
    if (!responsePresent && !completedWidget) return false;
    const button = ${button};
    if (!button || button.disabled) return false;
    sessionStorage.setItem('browserless-demo-submitted', '1');
    button.click();
    return true;
  `;
  const outcome = `return JSON.stringify({
    submitted: sessionStorage.getItem('browserless-demo-submitted') === '1',
    accepted: (${locationCheck}) && (${demo.success})
  });`;
  // Screenshot evidence must not contain solved response tokens from a demo's
  // result page. Scrub only after the acceptance observation, before capture.
  const redact = `
    document.querySelectorAll('textarea, pre, code').forEach(e => e.style.visibility = 'hidden');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      node.textContent = node.textContent.replace(/[A-Za-z0-9_.-]{32,}/g, '[response hidden]');
    }
    return true;
  `;
  return `mutation BrowserlessDemo {
    goto(url: ${JSON.stringify(demo.url)}) { status }
    widget: waitForSelector(selector: ${JSON.stringify(demo.widget)}, timeout: 10000) { time }
    prepare: evaluate(content: ${JSON.stringify(prepare)}) { value }
    attempt: if(selector: "body[data-browserless-demo-ready='1']") {
      solve(${demo.type ? `type: ${demo.type}, ` : ""}wait: true, timeout: 90000) {
        found solved time
      }
      submit: evaluate(content: ${JSON.stringify(submit)}) { value }
      accepted: waitForFunction(fn: ${JSON.stringify(demo.success)}, timeout: 8000) { time }
      outcome: evaluate(content: ${JSON.stringify(outcome)}) { value }
    }
    redact: evaluate(content: ${JSON.stringify(redact)}) { value }
    image: screenshot(type: png) { base64 }
  }`;
}

/** Runs once with no retries; ambiguous timeout outcomes must not be retried. */
export async function runBrowserlessDemo(
  raw: unknown,
  environment: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
) {
  const payload = browserlessDemoPayload.parse(raw);
  if (
    !isCaptchaPreviewEligible(environment, payload.userId) ||
    process.env.HACKERAI_ENVIRONMENT !== "preview" ||
    process.env.HACKERAI_BROWSERLESS_PILOT !== "1"
  ) {
    return { status: "unavailable" as const };
  }
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    return { status: "unavailable" as const };
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(115_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const started = Date.now();
  let requestStarted = false;
  try {
    const endpoint = new URL(
      "https://production-sfo.browserless.io/stealth/bql?timeout=110000",
    );
    // Some hCaptcha demo sessions are blocked before the widget loads.
    // Keep the provider's metered proxy confined to that fixed demo.
    if (payload.demo === "hcaptcha") {
      endpoint.searchParams.set("proxy", "residential");
      endpoint.searchParams.set("proxyCountry", "us");
      endpoint.searchParams.set("proxySticky", "true");
    }
    requestStarted = true;
    const response = await (options.fetch ?? fetch)(endpoint.href, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: buildBrowserlessDemoQuery(payload.demo),
        operationName: "BrowserlessDemo",
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      return {
        status: "provider_rejected" as const,
        httpStatus: response.status,
      };
    }
    const body = responseSchema.parse(await response.json());
    const attempt = body.data?.attempt;
    let outcome: z.infer<typeof outcomeSchema> | null = null;
    if (attempt?.outcome) {
      let value: unknown = attempt.outcome.value;
      for (let i = 0; i < 2 && typeof value === "string"; i++) {
        value = JSON.parse(value);
      }
      outcome = outcomeSchema.parse(value);
    }
    const solved = attempt?.solve?.solved === true;
    const submitted = outcome?.submitted === true;
    const image = body.data?.image?.base64;
    return {
      status: "completed" as const,
      demo: payload.demo,
      url: demos[payload.demo].url,
      controlOnly: demos[payload.demo].controlOnly,
      proxy: payload.demo === "hcaptcha" ? "residential" : "none",
      navigationStatus: body.data?.goto?.status ?? null,
      challengeReady: attempt != null,
      found: attempt?.solve?.found === true,
      providerSolved: solved,
      formSubmitted: submitted,
      websiteAccepted: solved && submitted && outcome?.accepted === true,
      outcomeObserved: outcome !== null,
      providerErrorCount: body.errors?.length ?? 0,
      failedStages: (body.errors ?? []).map(({ path }) => {
        const stage = path?.at(-1);
        return typeof stage === "string" &&
          [
            "goto",
            "widget",
            "prepare",
            "solve",
            "submit",
            "accepted",
            "outcome",
            "redact",
            "image",
          ].includes(stage)
          ? stage
          : "request";
      }),
      solveMs: attempt?.solve?.time ?? null,
      elapsedMs: Date.now() - started,
      ...(image && image.startsWith("iVBORw0KGgo") && { screenshotPng: image }),
    };
  } catch {
    // No provider errors, response tokens, headers, query or keys escape this
    // boundary. The vendor's 110-second session timeout also applies if the
    // local request disconnects; a disconnect alone does not prove cleanup.
    return {
      status: requestStarted
        ? ("outcome_unknown" as const)
        : ("unavailable" as const),
      demo: payload.demo,
      elapsedMs: Date.now() - started,
    };
  }
}
