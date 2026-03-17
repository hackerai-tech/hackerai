/**
 * Shared path validation utilities for sandbox environments.
 */

/**
 * Allowed base directories for file operations.
 * All file paths must resolve under one of these prefixes.
 */
export const ALLOWED_FILE_ROOTS = ["/tmp/hackerai-upload", "/tmp/hackerai"];

/**
 * Validate that a resolved file path is within allowed directories.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
export function validateFilePath(filePath: string): void {
  // Normalize: resolve .. and . segments
  const segments = filePath.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop();
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }
  const normalizedPath = "/" + resolved.join("/");

  const isAllowed = ALLOWED_FILE_ROOTS.some(
    (root) => normalizedPath === root || normalizedPath.startsWith(root + "/"),
  );

  if (!isAllowed) {
    throw new Error(
      `File path not allowed: "${filePath}". Must be under one of: ${ALLOWED_FILE_ROOTS.join(", ")}`,
    );
  }
}

/**
 * Validate that a URL is safe for download (block SSRF to internal networks).
 */
export function validateDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: "${url}"`);
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Download URL must use http or https protocol, got: ${parsed.protocol}`,
    );
  }

  // Block common internal/metadata IPs
  const hostname = parsed.hostname;
  const blockedPatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^localhost$/i,
    /^\[::1?\]$/,
    /^::1$/,
    /^::ffff:/i,
    /^metadata\.google\.internal$/i,
    /^0x[0-9a-f]+$/i,
    /^\d+$/,
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Download URL blocked: "${hostname}" resolves to an internal address`,
      );
    }
  }
}
