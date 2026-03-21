/**
 * Check if Codex CLI is installed and authenticated via Tauri IPC.
 * Caches the result for the session — only checks once.
 */
let _cache: {
  installed: boolean;
  authenticated: boolean;
  version?: string;
} | null = null;

export async function checkCodexStatus(): Promise<{
  installed: boolean;
  authenticated: boolean;
  version?: string;
} | null> {
  if (_cache) {
    return _cache;
  }

  console.log("[CodexLocal] Checking Codex CLI status...");
  try {
    const { invoke } = await import("@tauri-apps/api/core");

    const versionResult = await invoke<{
      stdout: string;
      stderr: string;
      exit_code: number;
    }>("execute_command", {
      command: "codex --version",
      timeoutMs: 5000,
    });

    console.log("[CodexLocal] codex --version:", {
      stdout: versionResult.stdout.trim(),
      stderr: versionResult.stderr.trim(),
      exit_code: versionResult.exit_code,
    });

    if (versionResult.exit_code !== 0) {
      console.log("[CodexLocal] Codex CLI not found");
      return { installed: false, authenticated: false };
    }

    const version = versionResult.stdout.trim();
    console.log("[CodexLocal] Codex CLI installed, version:", version);

    const authResult = await invoke<{
      stdout: string;
      stderr: string;
      exit_code: number;
    }>("execute_command", {
      command: "codex login status",
      timeoutMs: 5000,
    });

    console.log("[CodexLocal] codex login status:", {
      stdout: authResult.stdout.trim(),
      stderr: authResult.stderr.trim(),
      exit_code: authResult.exit_code,
    });

    const authenticated = authResult.exit_code === 0;
    console.log("[CodexLocal] Authenticated:", authenticated);

    _cache = { installed: true, authenticated, version };
    return _cache;
  } catch (err) {
    console.error("[CodexLocal] Check failed:", err);
    return null;
  }
}
