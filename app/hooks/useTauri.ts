"use client";

import { toast } from "sonner";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";

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

type AuthFallbackPath =
  | "/login"
  | "/signup"
  | `/login?${string}`
  | `/signup?${string}`;

type NavigateToAuthOptions = {
  preferSignInForReturningUser?: boolean;
};

function resolveAuthPath(
  fallbackPath: AuthFallbackPath,
  options?: NavigateToAuthOptions,
): AuthFallbackPath {
  if (!options?.preferSignInForReturningUser || !hasAuthenticatedBefore()) {
    return fallbackPath;
  }

  const authUrl = new URL(fallbackPath, window.location.origin);
  if (authUrl.pathname !== "/signup") {
    return fallbackPath;
  }

  authUrl.pathname = "/login";
  return `${authUrl.pathname}${authUrl.search}` as AuthFallbackPath;
}

export async function navigateToAuth(
  fallbackPath: AuthFallbackPath,
  options?: NavigateToAuthOptions,
): Promise<void> {
  const resolvedPath = resolveAuthPath(fallbackPath, options);

  if (detectTauri()) {
    try {
      let loginUrl = `${window.location.origin}/desktop-login`;
      const fallbackUrl = new URL(resolvedPath, window.location.origin);
      const authSearchParams = new URLSearchParams(fallbackUrl.search);

      if (fallbackUrl.pathname === "/signup") {
        authSearchParams.set("screen_hint", "sign-up");
      }

      // In dev mode, pass the local auth callback port so the server
      // redirects to localhost instead of the hackerai:// deep link
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const port = await invoke<number>("get_dev_auth_port");
        if (port > 0) {
          authSearchParams.set("dev_callback_port", String(port));
        }
      } catch {
        // Not in dev mode or command not available
      }

      const query = authSearchParams.toString();
      if (query) {
        loginUrl += `?${query}`;
      }

      const opened = await openInBrowser(loginUrl);
      if (opened) return;
    } catch {
      // Fall through to web navigation
    }
  }
  window.location.href = resolvedPath;
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

export type LocalFileMetadata = {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  lastModified: number;
};

export type LocalFileData = LocalFileMetadata & {
  base64: string;
};

export async function pickLocalFiles(): Promise<string[]> {
  if (!detectTauri()) return [];

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("pick_local_files");
  } catch (err) {
    console.error("[Tauri] Failed to pick local files:", err);
    toast.error("Failed to open file picker");
    return [];
  }
}

export async function getLocalFileMetadata(
  path: string,
): Promise<LocalFileMetadata | null> {
  if (!detectTauri()) return null;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<LocalFileMetadata>("get_local_file_metadata", {
      path,
    });
  } catch (err) {
    console.error("[Tauri] Failed to read local file metadata:", err);
    toast.error("Failed to read local file metadata");
    return null;
  }
}

export async function readLocalFile(
  path: string,
): Promise<LocalFileData | null> {
  if (!detectTauri()) return null;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<LocalFileData>("read_local_file", {
      path,
    });
  } catch (err) {
    console.error("[Tauri] Failed to read local file:", err);
    toast.error("Failed to read local file");
    return null;
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
