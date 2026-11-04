import { z } from "zod";

export const captchaKind = z.enum(["recaptcha_v2", "hcaptcha", "turnstile"]);
export type CaptchaKind = z.infer<typeof captchaKind>;

export const browserChallengeObservation = z.object({
  url: z.string().max(2048).url(),
  documentId: z.string().max(80),
  widgets: z
    .array(
      z.object({
        kind: captchaKind,
        siteKey: z.string().min(1).max(256),
        tokenPresent: z.boolean(),
        invisible: z.boolean(),
      }),
    )
    .max(10),
  interstitial: z.boolean(),
});
export type BrowserChallengeObservation = z.infer<
  typeof browserChallengeObservation
>;
export type CaptchaWidget = BrowserChallengeObservation["widgets"][number];

// Public demo URLs only. Never send a customer's URL, cookies or page content
// to a solver during this pilot. Match complete URLs, including query strings.
const DEMOS = new Set([
  "https://www.google.com/recaptcha/api2/demo",
  "https://accounts.hcaptcha.com/demo",
  "https://2captcha.com/demo/recaptcha-v2",
  "https://2captcha.com/demo/cloudflare-turnstile",
]);

// Public keys verified on these demos. A matching URL alone must not authorize
// a paid task for a site key injected into the page by another browser action.
const SOLVER_DEMOS: Record<string, { kind: CaptchaKind; siteKey: string }> = {
  "https://accounts.hcaptcha.com/demo": {
    kind: "hcaptcha",
    siteKey: "a5f74b19-9e45-40e0-b45d-47ff91b7a6c2",
  },
  "https://www.google.com/recaptcha/api2/demo": {
    kind: "recaptcha_v2",
    siteKey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
  },
  "https://2captcha.com/demo/recaptcha-v2": {
    kind: "recaptcha_v2",
    siteKey: "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u",
  },
  // Cloudflare's interactive test key: this demo proves wiring, not real
  // Turnstile challenge acceptance. Keep its results separate in QA.
  "https://2captcha.com/demo/cloudflare-turnstile": {
    kind: "turnstile",
    siteKey: "3x00000000000000000000FF",
  },
};

export function isSupportedCaptchaDemo(
  url: string,
  widget: CaptchaWidget,
): boolean {
  const expected = Object.hasOwn(SOLVER_DEMOS, url)
    ? SOLVER_DEMOS[url]
    : undefined;
  return (
    !!expected &&
    expected.kind === widget.kind &&
    expected.siteKey === widget.siteKey
  );
}

export function isCaptchaDemo(url: string): boolean {
  return DEMOS.has(url);
}

const configuredTargets = z
  .array(
    z.object({
      url: z
        .string()
        .max(2048)
        .url()
        .refine((value) => {
          const parsed = new URL(value);
          return (
            parsed.protocol === "https:" &&
            !parsed.username &&
            !parsed.password &&
            !parsed.search &&
            !parsed.hash
          );
        }),
      kind: captchaKind,
      siteKey: z.string().regex(/^[A-Za-z0-9_-]{10,256}$/),
    }),
  )
  .max(20);

/** Additional targets require exact server-side approval, never a tool input.
 * This authorizes sharing the selected URL and public widget key only.
 */
export function isSupportedCaptchaTarget(
  url: string,
  widget: CaptchaWidget,
  configuration = process.env.CAPTCHA_SOLVER_PREVIEW_TARGETS,
): boolean {
  if (isSupportedCaptchaDemo(url, widget)) return true;
  if (!configuration || configuration.length > 16384) return false;
  try {
    const targets = configuredTargets.parse(JSON.parse(configuration));
    return targets.some(
      (target) =>
        target.url === url &&
        target.kind === widget.kind &&
        target.siteKey === widget.siteKey,
    );
  } catch {
    return false;
  }
}

/** Runs inside the owned page. A literal avoids bundler/coverage helper references.
 * Return booleans, never response-token values.
 */
export const DETECT_CHALLENGES_SCRIPT = String.raw`(() => {
  const widgets = [];
  for (const element of document.querySelectorAll("[data-sitekey]")) {
    if (widgets.length === 10) break;
    const kind = element.matches(".g-recaptcha") ? "recaptcha_v2"
      : element.matches(".h-captcha") ? "hcaptcha"
        : element.matches(".cf-turnstile") ? "turnstile" : null;
    const siteKey = element.getAttribute("data-sitekey");
    if (!kind || !siteKey || siteKey.length > 256) continue;
    const container = element.closest("form") ?? element.parentElement ?? element;
    const field = container.querySelector(
      kind === "recaptcha_v2" ? '[name="g-recaptcha-response"]'
        : kind === "hcaptcha" ? '[name="h-captcha-response"]'
          : '[name="cf-turnstile-response"]',
    );
    widgets.push({kind, siteKey, tokenPresent: !!field?.value,
      invisible: element.getAttribute("data-size") === "invisible"});
  }
  return {
    url: location.href,
    documentId: String(performance.timeOrigin),
    widgets,
    interstitial: !!document.querySelector(
      '#challenge-running, #challenge-stage, form#challenge-form',
    ),
  };
})()`;

/** A delivered token still needs application/server validation after submission. */
export function buildDeliverCaptchaScript(
  observation: BrowserChallengeObservation,
  widget: CaptchaWidget,
  token: string,
): string {
  // The script travels exclusively over protected process stdin.
  return `((expected, widget, token) => {
    if (location.href !== expected.url || String(performance.timeOrigin) !== expected.documentId) return {status: 'page_changed'};
    const selector = widget.kind === 'recaptcha_v2' ? '.g-recaptcha' : widget.kind === 'hcaptcha' ? '.h-captcha' : '.cf-turnstile';
    const matches = [...document.querySelectorAll(selector)].filter(el => el.getAttribute('data-sitekey') === widget.siteKey);
    if (matches.length !== 1) return {status: 'page_changed'};
    const element = matches[0];
    const container = element.closest('form') || element.parentElement || element;
    const name = widget.kind === 'recaptcha_v2' ? 'g-recaptcha-response' : widget.kind === 'hcaptcha' ? 'h-captcha-response' : 'cf-turnstile-response';
    const fields = [...container.querySelectorAll('[name="' + name + '"]')];
    if (fields.length !== 1 || fields[0].value) return {status: 'page_changed'};
    fields[0].value = token;
    fields[0].dispatchEvent(new Event('input', {bubbles: true}));
    fields[0].dispatchEvent(new Event('change', {bubbles: true}));
    const callbackName = element.getAttribute('data-callback');
    if (callbackName && /^[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*)*$/.test(callbackName)) {
      const parts = callbackName.split('.');
      let parent = window;
      for (const part of parts.slice(0, -1)) parent = parent?.[part];
      const callback = parent?.[parts.at(-1)];
      if (typeof callback === 'function') callback.call(parent, token);
    }
    return {status: 'token_delivered', websiteAccepted: false};
  })(${JSON.stringify({ url: observation.url, documentId: observation.documentId })}, ${JSON.stringify(widget)}, ${JSON.stringify(token)})`;
}
