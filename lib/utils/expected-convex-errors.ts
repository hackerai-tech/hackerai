const EXPECTED_CONVEX_ERROR_CODES = new Set([
  "CHAT_ACCESS_SUSPENDED",
  "CHAT_UNAUTHORIZED",
  "FILE_SIZE_EXCEEDED",
  "FILE_TOKEN_LIMIT_EXCEEDED",
  "FILE_UPLOAD_RATE_LIMIT",
  "IMAGE_SIZE_EXCEEDED",
  "INVALID_FILE_SIZE",
  "INVALID_IMAGE_BYTES",
  "PAID_PLAN_REQUIRED",
  "STORAGE_LIMIT_EXCEEDED",
]);

export function getConvexErrorCodeFromText(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as { code?: unknown }).code;
      return typeof code === "string" ? code : undefined;
    }
  } catch {
    const match = value.replace(/\\"/g, '"').match(/"code"\s*:\s*"([^"]+)"/);
    return match?.[1];
  }

  return undefined;
}

export function isExpectedConvexErrorCode(code: unknown): boolean {
  return typeof code === "string" && EXPECTED_CONVEX_ERROR_CODES.has(code);
}
