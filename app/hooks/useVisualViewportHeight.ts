import { useEffect } from "react";

/**
 * Tracks window.visualViewport.height as the CSS variable --vvh on
 * documentElement so layouts can shrink above the mobile keyboard on iOS
 * Safari, where interactive-widget=resizes-content is not supported. Also
 * pins html/body so the browser's scroll-into-view on focus can't push
 * the page above the viewport on Chromium Android.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    const body = document.body;
    const prevRootOverflow = root.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    const update = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
    };

    // Some Chromium Android builds don't fire visualViewport.resize when the
    // keyboard closes via blur, so re-read on the next frame after focusout
    // and on window resize.
    let raf = 0;
    const updateNextFrame = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", updateNextFrame);
    document.addEventListener("focusout", updateNextFrame);

    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", updateNextFrame);
      document.removeEventListener("focusout", updateNextFrame);
      root.style.removeProperty("--vvh");
      root.style.overflow = prevRootOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);
}
