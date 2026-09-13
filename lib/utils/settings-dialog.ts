const EVENT_NAME = "open-settings-dialog";

type SettingsDialogModule = typeof import("@/app/components/SettingsDialog");

let settingsDialogModulePromise: Promise<SettingsDialogModule> | null = null;

interface OpenSettingsDetail {
  tab?: string;
}

/** Load the Settings dialog bundle once, resetting the cache if loading fails. */
export function loadSettingsDialog(): Promise<SettingsDialogModule> {
  if (!settingsDialogModulePromise) {
    settingsDialogModulePromise =
      import("@/app/components/SettingsDialog").catch((error) => {
        settingsDialogModulePromise = null;
        throw error;
      });
  }

  return settingsDialogModulePromise;
}

/** Warm the Settings dialog bundle from browser user intent. */
export function preloadSettingsDialog(): void {
  if (typeof window === "undefined") return;
  void loadSettingsDialog().catch(() => undefined);
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
