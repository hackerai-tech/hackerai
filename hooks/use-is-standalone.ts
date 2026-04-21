import * as React from "react";

export function useIsStandalone() {
  const [isStandalone, setIsStandalone] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia("(display-mode: standalone)");
    const iosStandalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true;

    const update = () => setIsStandalone(mql.matches || iosStandalone);
    update();

    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isStandalone;
}
