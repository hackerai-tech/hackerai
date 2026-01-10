"use client";

declare global {
  interface Window {
    __TAURI__?: {
      shell: {
        open: (url: string) => Promise<void>;
      };
    };
    __TAURI_INTERNALS__?: unknown;
  }
}

function detectTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined)
  );
}

export function useTauri(): { isTauri: boolean } {
  const isTauri = detectTauri();
  return { isTauri };
}

export async function openInBrowser(url: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.__TAURI__?.shell?.open) {
    await window.__TAURI__.shell.open(url);
    return true;
  }

  return false;
}
