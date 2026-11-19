/**
 * Cross-platform utilities shared across sandbox implementations.
 */

/**
 * Map reported OS names to Node `process.platform` IDs. Desktop's native OS
 * info reports Rust `std::env::consts::OS` names. Its uname probe historically
 * published MSYS/Git Bash kernel names; they identify Windows hosts even
 * though their command shell is POSIX.
 */
export function normalizeSandboxPlatform(platform: string): string {
  if (platform === "windows") return "win32";
  if (platform === "macos") return "darwin";
  return /^(?:mingw32|mingw64|msys)_nt(?:-|$)/i.test(platform)
    ? "win32"
    : platform;
}

/**
 * Convert a Node.js `process.platform` value to a human-readable OS name.
 */
export function getPlatformDisplayName(platform: string): string {
  switch (normalizeSandboxPlatform(platform)) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

/**
 * Escape a value for safe inline use in a shell command string.
 * On Windows (`win32`): wraps in double quotes and escapes inner double quotes.
 * On POSIX: wraps in single quotes with the standard '\'' escape for inner quotes.
 *
 * @param value - The string to escape
 * @param platform - Override platform for testing (defaults to process.platform)
 */
export function escapeShellValue(value: string, platform?: string): string {
  const p =
    platform ?? (typeof process !== "undefined" ? process.platform : "linux");
  if (p === "win32") {
    // cmd /C: wrap in double quotes, escape inner double quotes
    return `"${value.replace(/"/g, '""')}"`;
  }
  // POSIX shells: wrap in single quotes, escape inner single quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A backslash is a filename character on POSIX, even on a Windows worker. */
export function getSandboxFileName(path: string, windows: boolean): string {
  return path.split(windows ? /[/\\]/ : /\//).pop() || "file";
}
