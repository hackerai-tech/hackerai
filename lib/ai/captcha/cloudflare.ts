import { z } from "zod";

const urls = z
  .array(
    z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
  )
  .max(5);

/** Managed challenges disclose opaque per-page parameters as well as the URL.
 * Keep this separate from standalone widgets and opt in only in Preview.
 */
export function cloudflarePreviewUrls(
  environment: string | undefined,
): string[] {
  if (environment !== "PREVIEW") return [];
  try {
    return urls.parse(
      JSON.parse(process.env.CAPTCHA_CLOUDFLARE_PREVIEW_URLS ?? "[]"),
    );
  } catch {
    return [];
  }
}

export const cloudflareParameters = z.object({
  action: z.literal("managed"),
  data: z.string().min(1).max(2048),
  pagedata: z.string().min(1).max(16384),
  userAgent: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[\x20-\x7e]+$/),
});

/** Cloudflare can add a transient challenge query during navigation. Never
 * send that signed query to the solver or treat unrelated query values as an
 * approved target. Authorization still requires the exact configured page.
 */
export function cloudflarePageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some(
        (key) => !/^__cf_chl_[A-Za-z0-9_]+$/.test(key),
      )
    )
      return undefined;
    return url.origin + url.pathname;
  } catch {
    return undefined;
  }
}

export const CLOUDFLARE_PAGE_URL_SCRIPT = String.raw`(() => {
  const url = new URL(location.href);
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !/^__cf_chl_[A-Za-z0-9_]+$/.test(key))) return null;
  return url.origin + url.pathname;
})()`;

/** Observe clearance, not form acceptance. A replacement managed challenge
 * consumes no new solve and must be restored for manual verification.
 */
export function cloudflareOutcomeScript(url: string): string {
  return `(async () => {
    const until = Date.now() + 4000;
    do {
      if (window !== top || ${CLOUDFLARE_PAGE_URL_SCRIPT} !== ${JSON.stringify(url)}) return 'page_changed';
      const current = window[Symbol.for('hackerai.cloudflareChallenge')];
      const blocked = !!document.querySelector('#challenge-running, #challenge-stage, form#challenge-form, #cf-error-details') ||
        /^(Just a moment|Cloudflare Security|Attention Required.*Cloudflare)/i.test(document.title) ||
        /Performing security verification|Verifying you are human/.test(document.querySelector('h2')?.textContent ?? '');
      if (!blocked && (!current || current.delivered) && document.readyState !== 'loading' && document.body?.textContent?.trim()) return 'cleared';
      if (Date.now() >= until) return 'pending';
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
  })()`;
}

export function cloudflareReleaseScript(approvedUrls: string[]): string {
  return `(() => {
    if (window !== top || !${JSON.stringify(approvedUrls)}.includes(${CLOUDFLARE_PAGE_URL_SCRIPT})) return false;
    try { sessionStorage.setItem('hackerai.cloudflareManual:' + ${CLOUDFLARE_PAGE_URL_SCRIPT}, '1'); } catch {}
    const current = window[Symbol.for('hackerai.cloudflareChallenge')];
    if (!current || current.delivered || typeof current.release !== 'function') return false;
    return current.release() === true;
  })()`;
}

/** Install before navigation. Intercept only the approved page's managed
 * challenge; normal widgets retain their original render function. No logging.
 */
export function cloudflareInitScript(approvedUrls: string[]): string {
  return `(() => {
    const current = new URL(location.href);
    if (window !== top || !${JSON.stringify(approvedUrls)}.includes(current.origin + current.pathname)) return;
    const canonical = ${CLOUDFLARE_PAGE_URL_SCRIPT};
    window[Symbol.for('hackerai.cloudflareInit')] = {exact:location.href === canonical, queryAllowed:!!canonical};
    if (!canonical) return;
    // Releasing a detached widget cannot replay it. Let a human reload this
    // page without capturing it again, for the lifetime of this owned tab.
    const manualKey = 'hackerai.cloudflareManual:' + canonical;
    const manualRequested = () => {
      try { return sessionStorage.getItem(manualKey) === '1'; } catch { return false; }
    };
    if (manualRequested()) return;
    const key = Symbol.for('hackerai.cloudflareChallenge');
    let disabled = false;
    let timer;
    const wrap = (api) => {
      if (disabled || manualRequested() || !api || typeof api.render !== 'function' || api.render.__hackeraiWrapped) return;
      const original = api.render;
      const render = function(container, options) {
        if (disabled || manualRequested() || options?.action !== 'managed' || typeof options.cData !== 'string' ||
            !options.cData || options.cData.length > 2048 ||
            typeof options.chlPageData !== 'string' || !options.chlPageData ||
            options.chlPageData.length > 16384 || typeof options.callback !== 'function' ||
            !/^[A-Za-z0-9_-]{10,256}$/.test(options.sitekey ?? ''))
          return original.apply(this, arguments);
        let target;
        try { target = typeof container === 'string' ? document.querySelector(container) : container; }
        catch { return original.apply(this, arguments); }
        if (!(target instanceof Element) || !target.isConnected) return original.apply(this, arguments);
        const observationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        // Re-rendering replaces the identity, so an older solution cannot land.
        window[key] = {siteKey:options.sitekey, observationId, callback:options.callback,
          action:options.action, data:options.cData, pagedata:options.chlPageData,
          userAgent:navigator.userAgent, delivered:false};
        const captured = window[key];
        const receiver = this;
        const args = Array.from(arguments);
        args[1] = {...options};
        captured.release = () => {
          if (window[key] !== captured || captured.delivered) return false;
          try { sessionStorage.setItem(manualKey, '1'); } catch {}
          disabled = true;
          clearInterval(timer);
          api.render = original;
          delete window[key];
          if (!target.isConnected || (typeof container === 'string' && document.querySelector(container) !== target)) return false;
          original.apply(receiver, args);
          return true;
        };
        return 'hackerai-' + observationId;
      };
      render.__hackeraiWrapped = true;
      api.render = render;
    };
    // The vendor checks 'turnstile' in window before loading. Reserving that
    // property, even with an undefined getter, makes it skip initialization.
    wrap(window.turnstile);
    // Wait for the real API before wrapping; do not reserve its global name.
    timer = setInterval(() => wrap(window.turnstile), 10);
    setTimeout(() => clearInterval(timer), 30000);
  })()`;
}
