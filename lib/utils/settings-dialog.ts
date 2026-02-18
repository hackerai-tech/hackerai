const EVENT_NAME = "open-settings-dialog";

interface OpenSettingsDetail {
  tab?: string;
}

/** Fire from anywhere to open the Settings dialog (optionally to a specific tab). */
export function openSettingsDialog(tab?: string) {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(EVENT_NAME, { detail: { tab } }),
  );
}

/** Subscribe to open-settings requests. Returns a cleanup function. */
export function onOpenSettingsDialog(
  callback: (tab?: string) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<OpenSettingsDetail>).detail;
    callback(detail?.tab);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
