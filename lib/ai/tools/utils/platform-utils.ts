/**
 * Cross-platform utilities shared across sandbox implementations.
 */

/**
 * Convert a Node.js `process.platform` value to a human-readable OS name.
 */
export function getPlatformDisplayName(platform: string): string {
  switch (platform) {
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
