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
