import { z } from "zod";
import { cloudflareParameters, cloudflarePreviewUrls } from "./cloudflare";

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
        observationId: z.string().regex(/^[a-f0-9]{32}$/),
        tokenPresent: z.boolean(),
        invisible: z.boolean(),
        managed: cloudflareParameters.optional(),
      }),
    )
    .max(10),
  interstitial: z.boolean(),
});
export type BrowserChallengeObservation = z.infer<
  typeof browserChallengeObservation
>;
export type CaptchaWidget = BrowserChallengeObservation["widgets"][number];

// Public demo defaults. Additional URLs and widget keys require explicit server
// configuration. Never send cookies or page content. Match complete URLs.
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
  if (widget.managed) return false;
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
  configuration = process.env.CAPTCHA_SOLVER_TARGETS ??
    (process.env.HACKERAI_ENVIRONMENT === "preview"
      ? process.env.CAPTCHA_SOLVER_PREVIEW_TARGETS
      : undefined),
): boolean {
  if (widget.managed)
    return (
      widget.kind === "turnstile" &&
      process.env.HACKERAI_ENVIRONMENT === "preview" &&
      cloudflarePreviewUrls("PREVIEW").includes(url)
    );
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
  const managed = window[Symbol.for('hackerai.cloudflareChallenge')];
  if (managed && !managed.delivered) widgets.push({kind:'turnstile', siteKey:managed.siteKey,
    observationId:managed.observationId, tokenPresent:false, invisible:false,
    managed:{action:managed.action, data:managed.data, pagedata:managed.pagedata, userAgent:managed.userAgent}});
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
    // Element properties do not survive DOM replacement/cloning. Pin the
    // response field too, so a re-render cannot receive an earlier solve.
    const observationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    element[Symbol.for('hackerai.captchaObservation')] = {observationId, field};
    widgets.push({kind, siteKey, observationId, tokenPresent: !!field?.value,
      invisible: element.getAttribute("data-size") === "invisible"});
  }
  return {
    url: location.href,
    documentId: String(performance.timeOrigin),
    widgets,
    interstitial: !!managed || !!document.querySelector(
      '#challenge-running, #challenge-stage, form#challenge-form',
    ) || (!!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') &&
      /^(Just a moment|Cloudflare Security)/i.test(document.title)) ||
      (!document.querySelector('form') && !!document.querySelector('iframe[title="Widget containing a Cloudflare security challenge"]') &&
        /Performing security verification|Verifying you are human/.test(document.querySelector('h2')?.textContent ?? '')) ||
      (!!document.querySelector('a[href*="cloudflare.com"][href*="challenge"]') &&
        /Performing security verification|Verifying you are human/.test(document.body?.innerText ?? '')),
  };
})()`;

/** A delivered token still needs application/server validation after submission. */
export function buildDeliverCaptchaScript(
  observation: BrowserChallengeObservation,
  widget: CaptchaWidget,
  token: string,
): string {
  if (widget.managed)
    return `((expected, widget, token) => {
    if (location.href !== expected.url || String(performance.timeOrigin) !== expected.documentId) return {status:'page_changed'};
    const current = window[Symbol.for('hackerai.cloudflareChallenge')];
    if (!current || current.delivered || current.siteKey !== widget.siteKey ||
        current.observationId !== widget.observationId || typeof current.callback !== 'function')
      return {status:'page_changed'};
    current.delivered = true;
    current.callback(token);
    return {status:'token_delivered', websiteAccepted:false};
  })(${JSON.stringify({ url: observation.url, documentId: observation.documentId })}, ${JSON.stringify({ siteKey: widget.siteKey, observationId: widget.observationId })}, ${JSON.stringify(token)})`;
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
    const observed = element[Symbol.for('hackerai.captchaObservation')];
    if (!widget.observationId || observed?.observationId !== widget.observationId || observed.field !== fields[0]) return {status: 'page_changed'};
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
