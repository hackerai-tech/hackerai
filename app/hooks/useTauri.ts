"use client";

import { toast } from "sonner";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function detectTauri(): boolean {
  return (
    typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
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

export async function navigateToAuth(
  fallbackPath: "/login" | "/signup",
): Promise<void> {
  if (detectTauri()) {
    try {
      let loginUrl = `${window.location.origin}/desktop-login`;

      // In dev mode, pass the local auth callback port so the server
      // redirects to localhost instead of the hackerai:// deep link
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const port = await invoke<number>("get_dev_auth_port");
        if (port > 0) {
          loginUrl += `?dev_callback_port=${port}`;
        }
      } catch {
        // Not in dev mode or command not available
      }

      const opened = await openInBrowser(loginUrl);
      if (opened) return;
    } catch {
      // Fall through to web navigation
    }
  }
  window.location.href = fallbackPath;
}

/**
 * Get the local command execution server info (port + auth token).
 * Returns null if not in Tauri or server not started.
 */
export async function getCmdServerInfo(): Promise<{
  port: number;
  token: string;
} | null> {
  if (!detectTauri()) {
    return null;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{
      port: number;
      token: string;
    }>("get_cmd_server_info");
    if (info.port > 0 && info.token) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Set the Convex auth (URL + user token) on the Tauri backend.
 * Used to enable the Notes API bridge with user's own auth token.
 */
export async function setConvexAuth(
  url: string,
  token: string,
  notesEnabled: boolean,
): Promise<boolean> {
  if (!detectTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_convex_auth", { url, token, notesEnabled });
    return true;
  } catch (err) {
    console.error("[Tauri] Failed to set Convex auth:", err);
    return false;
  }
}

/**
 * Reveal a file or folder in the OS file manager (Finder/Explorer).
 */
export async function revealFileInDir(path: string): Promise<boolean> {
  if (!detectTauri()) {
    return false;
  }

  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(path);
    return true;
  } catch (err) {
    console.error("[Tauri] Failed to reveal file:", path, err);
    toast.error("File not found", { description: path });
    return false;
  }
}

/**
 * Save file content to disk via command server.
 * Tries Downloads folder first, falls back to current working directory.
 * Returns the full path of the saved file, or null if both attempts fail.
 */
export async function saveFileToLocal(
  filename: string,
  content: string,
): Promise<string | null> {
  const info = await getCmdServerInfo();
  if (!info) return null;

  const escaped = filename.replace(/'/g, "'\\''");

  const delimiter = `HACKERAI_EOF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

  const writeToDir = async (dir: string) => {
    const targetPath = `${dir}/${escaped}`;
    const res = await fetch(`http://127.0.0.1:${info.port}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify({
        command: `cat > '${targetPath}' << '${delimiter}'\n${content}\n${delimiter}`,
        timeout_ms: 5000,
      }),
    });
    if (!res.ok) throw new Error("Request failed");
    const result = await res.json();
    if (result.exit_code !== 0) throw new Error("Write failed");
    return `${dir}/${filename}`;
  };

  // Try Downloads folder first
  try {
    const pathMod = await import("@tauri-apps/api/path");
    const downloadsDir = (await pathMod.downloadDir()).replace(/\/+$/, "");
    return await writeToDir(downloadsDir);
  } catch {
    // Fall back to current directory
  }

  try {
    const cwdRes = await fetch(`http://127.0.0.1:${info.port}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify({ command: "pwd", timeout_ms: 3000 }),
    });
    if (cwdRes.ok) {
      const cwdResult = await cwdRes.json();
      const cwd = cwdResult.stdout?.trim();
      if (cwd) return await writeToDir(cwd);
    }
  } catch {
    // Both failed
  }

  return null;
}

export async function openDownloadsFolder(): Promise<boolean> {
  if (!detectTauri()) {
    return false;
  }

  try {
    // Dynamic imports for Tauri plugins - only available in desktop context

    const opener = await (import("@tauri-apps/plugin-opener") as Promise<any>);

    const path = await (import("@tauri-apps/api/path") as Promise<any>);
    const downloadsPath = await path.downloadDir();
    await opener.openPath(downloadsPath);
    return true;
  } catch (err) {
    console.error("[Tauri] Failed to open Downloads folder:", err);
    return false;
  }
}
