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

/** Install before navigation. Intercept only the approved page's managed
 * challenge; normal widgets retain their original render function. No logging.
 */
export function cloudflareInitScript(approvedUrls: string[]): string {
  return `(() => {
    if (window !== top || !${JSON.stringify(approvedUrls)}.includes(location.href)) return;
    const key = Symbol.for('hackerai.cloudflareChallenge');
    let disabled = false;
    let timer;
    const wrap = (api) => {
      if (disabled || !api || typeof api.render !== 'function' || api.render.__hackeraiWrapped) return;
      const original = api.render;
      const render = function(container, options) {
        if (options?.action !== 'managed' || typeof options.cData !== 'string' ||
            !options.cData || options.cData.length > 2048 ||
            typeof options.chlPageData !== 'string' || !options.chlPageData ||
            options.chlPageData.length > 16384 || typeof options.callback !== 'function' ||
            !/^[A-Za-z0-9_-]{10,256}$/.test(options.sitekey ?? ''))
          return original.apply(this, arguments);
        const observationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        // Re-rendering replaces the identity, so an older solution cannot land.
        window[key] = {siteKey:options.sitekey, observationId, callback:options.callback,
          action:options.action, data:options.cData, pagedata:options.chlPageData,
          userAgent:navigator.userAgent, delivered:false};
        const captured = window[key];
        const receiver = this;
        const args = arguments;
        captured.release = () => {
          if (window[key] !== captured || captured.delivered) return;
          disabled = true;
          clearInterval(timer);
          api.render = original;
          delete window[key];
          original.apply(receiver, args);
        };
        return 'hackerai-' + observationId;
      };
      render.__hackeraiWrapped = true;
      api.render = render;
    };
    let api = window.turnstile;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'turnstile');
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(window, 'turnstile', {configurable:true, enumerable:true,
        get:() => api, set:value => {api = value; wrap(api);}});
    }
    wrap(api);
    // Some versions assign render after assigning the API object. Bound the hook.
    timer = setInterval(() => wrap(window.turnstile), 10);
    setTimeout(() => clearInterval(timer), 30000);
  })()`;
}
