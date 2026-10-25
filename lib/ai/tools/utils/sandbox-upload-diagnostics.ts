/** Numeric diagnostics only: never return a URL, signing material or error text. */
export function getUploadFailureDiagnostics(
  uploadUrl: string,
  error: unknown,
  now = Date.now(),
) {
  const fields: {
    upload_reported_http_status: number | null;
    upload_signature_age_ms: number | null;
    upload_signature_ttl_ms: number | null;
    upload_signature_remaining_ms: number | null;
  } = {
    upload_reported_http_status: null,
    upload_signature_age_ms: null,
    upload_signature_ttl_ms: null,
    upload_signature_remaining_ms: null,
  };
  // Curl's own diagnostic, optionally wrapped by our upload adapter. An
  // arbitrary number in a filename or another error must not become a status.
  try {
    const text =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
    const status = text.match(
      /^(?:Failed to upload file: )?curl: \(22\) The requested URL returned error: ([45]\d{2})\r?$/m,
    );
    if (status) fields.upload_reported_http_status = Number(status[1]);
  } catch {
    // Diagnostics must preserve even an unusual original error.
  }
  try {
    const params = new URL(uploadUrl).searchParams;
    const dates = params.getAll("X-Amz-Date");
    const lifetimes = params.getAll("X-Amz-Expires");
    if (dates.length !== 1 || lifetimes.length !== 1) return fields;
    const date = dates[0];
    if (!/^\d{8}T\d{6}Z$/.test(date) || !/^\d{1,6}$/.test(lifetimes[0]))
      return fields;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}.000Z`;
    const signedAt = Date.parse(iso);
    const ttl = Number(lifetimes[0]) * 1_000;
    if (
      !Number.isFinite(signedAt) ||
      new Date(signedAt).toISOString() !== iso ||
      ttl <= 0 ||
      !Number.isSafeInteger(now)
    )
      return fields;
    const age = now - signedAt;
    const remaining = ttl - age;
    if (!Number.isSafeInteger(age) || !Number.isSafeInteger(remaining))
      return fields;
    fields.upload_signature_age_ms = age;
    fields.upload_signature_ttl_ms = ttl;
    fields.upload_signature_remaining_ms = remaining;
  } catch {
    // Missing/malformed signing timestamps are unknown, not evidence of expiry.
  }
  // Negative age can indicate clock skew; remaining time is an observation at
  // failure logging, not an assertion about the remote server's clock/access.
  return fields;
}
