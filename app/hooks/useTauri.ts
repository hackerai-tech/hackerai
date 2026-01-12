"use client";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function detectTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    window.__TAURI_INTERNALS__ !== undefined
  );
}

export function isTauriEnvironment(): boolean {
  return detectTauri();
}

export function useTauri(): { isTauri: boolean } {
  const isTauri = detectTauri();
  return { isTauri };
}

export async function openInBrowser(url: string): Promise<boolean> {
  if (!detectTauri()) {
    return false;
  }

  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
    return true;
  } catch (err) {
    console.error("[Tauri] Failed to open URL in browser:", url, err);
    return false;
  }
}

export async function navigateToAuth(fallbackPath: "/login" | "/signup"): Promise<void> {
  if (detectTauri()) {
    try {
      const opened = await openInBrowser(
        `${window.location.origin}/desktop-login`,
      );
      if (opened) return;
    } catch {
      // Fall through to web navigation
    }
  }
  window.location.href = fallbackPath;
}

export async function openDownloadsFolder(): Promise<boolean> {
  if (!detectTauri()) {
    return false;
  }

  try {
    // Dynamic imports for Tauri plugins - only available in desktop context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opener = await (import("@tauri-apps/plugin-opener") as Promise<any>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = await (import("@tauri-apps/api/path") as Promise<any>);
    const downloadsPath = await path.downloadDir();
    await opener.openPath(downloadsPath);
    return true;
  } catch (err) {
    console.error("[Tauri] Failed to open Downloads folder:", err);
    return false;
  }
}
