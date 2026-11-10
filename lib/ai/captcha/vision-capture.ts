import { z } from "zod";
import { DETECT_CHALLENGES_SCRIPT } from "./detection";
import type { FocusedChallenge } from "./vision-image";

export type VisionCaptureRequest = {
  path: string;
  prepareScript: string;
  measureScript: string;
};

export const visionCaptureResult = z.object({
  path: z.string().regex(/^\/tmp\/[A-Za-z0-9_.-]{1,160}\.png$/),
  viewport: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  frame: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  image: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  devicePixelRatio: z.number().finite().positive(),
});
export type VisionCaptureResult = z.infer<typeof visionCaptureResult>;
/** The original viewport stays authoritative when focusing is unavailable. */
export type VisionCapture = VisionCaptureResult &
  ({ focused: FocusedChallenge } | { focusedUnavailable: true });

/** Only this exact viewport capture can replace the model's shell execution. */
export function visionScreenshotRequest(command: string) {
  const match =
    /^agent-browser --session ([A-Za-z0-9_-]{1,80}) screenshot (\/tmp\/[A-Za-z0-9_.-]{1,160}\.png)$/.exec(
      command.trim(),
    );
  return match ? { sessionName: match[1], path: match[2] } : undefined;
}

/** Public frame geometry only; never enter the cross-origin puzzle or read answers. */
export function buildVisionCaptureScripts(scope: {
  url: string;
  documentId: string;
  kind: string;
  siteKey: string;
  widgetId?: string;
}) {
  // Callers may retain sandbox handles or other private fields alongside this scope.
  const expected = {
    url: scope.url,
    documentId: scope.documentId,
    kind: scope.kind,
    siteKey: scope.siteKey,
    widgetId: scope.widgetId,
  };
  const build = (scroll: boolean) => String.raw`((expected, scroll) => {
    if (location.href !== expected.url || String(performance.timeOrigin) !== expected.documentId)
      return {status:'page_changed'};
    const current = ${DETECT_CHALLENGES_SCRIPT};
    const w = current.widgets[0];
    if (current.interstitial || current.widgets.length !== 1 || w.kind !== expected.kind ||
        w.siteKey !== expected.siteKey || w.hcaptchaWidgetId !== expected.widgetId ||
        w.tokenPresent || w.invisible || w.managed) return {status:'scope_changed'};
    const frames = [...document.querySelectorAll('iframe')].filter(frame => {
      let src; try { src = new URL(frame.src); } catch { return false; }
      if (src.protocol !== 'https:' || src.username || src.password) return false;
      if (expected.kind === 'hcaptcha') {
        const p = new URLSearchParams(src.hash.slice(1));
        if (!(src.hostname === 'hcaptcha.com' || src.hostname.endsWith('.hcaptcha.com')) ||
          !src.pathname.endsWith('/hcaptcha.html') || p.get('frame') !== 'challenge' ||
          (expected.widgetId && p.get('id') !== expected.widgetId)) return false;
      } else if (expected.kind === 'recaptcha_v2') {
        if (!['www.google.com','www.recaptcha.net','recaptcha.google.com'].includes(src.hostname) ||
          !/^\/recaptcha\/(api2|enterprise)\/bframe$/.test(src.pathname) ||
          src.searchParams.get('k') !== expected.siteKey) return false;
      } else return false;
      const r = frame.getBoundingClientRect(), s = getComputedStyle(frame);
      return r.width > 0 && r.height > 0 && !frame.hidden && s.display !== 'none' &&
        s.visibility !== 'hidden' && s.opacity !== '0';
    });
    if (frames.length !== 1) return {status:frames.length ? 'ambiguous' : 'not_visible'};
    const frame = frames[0];
    if (scroll) frame.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const r = frame.getBoundingClientRect();
    const inset = Math.min(10,r.width/4,r.height/4);
    const points = [[r.left+inset,r.top+inset],[r.right-inset,r.top+inset],
      [r.left+inset,r.bottom-inset],[r.right-inset,r.bottom-inset],
      [r.left+r.width/2,r.top+r.height/2]];
    const needsViewport = r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
    let opacity = 1;
    for (let node = frame; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity || 1);
    const fullyVisible = !needsViewport && opacity >= 0.99 &&
      points.every(([x,y]) => document.elementFromPoint(x,y) === frame);
    return {status:'measured',fullyVisible,needsViewport,viewport:{width:innerWidth,height:innerHeight},
      frame:{x:r.x,y:r.y,width:r.width,height:r.height},devicePixelRatio};
  })(${JSON.stringify(expected)},${scroll})`;
  return { prepareScript: build(true), measureScript: build(false) };
}
