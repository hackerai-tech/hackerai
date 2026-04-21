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

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--vvh");
      root.style.overflow = prevRootOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);
}
