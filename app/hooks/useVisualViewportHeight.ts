import { useEffect } from "react";

/**
 * Tracks window.visualViewport.height as the CSS variable --vvh on
 * documentElement so layouts can shrink above the mobile keyboard on iOS
 * Safari, where interactive-widget=resizes-content is not supported.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
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
    };
  }, []);
}
