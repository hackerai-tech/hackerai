// S3's bounded Code is useful; its Message and canonical request can contain
// object keys, credentials and signing material and must never leave the host.
const STORAGE_ERROR_CODES = [
  "AccessDenied",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "InvalidToken",
  "InvalidAccessKeyId",
  "RequestTimeTooSkewed",
  "AuthorizationHeaderMalformed",
  "AuthorizationQueryParametersError",
  "BadDigest",
  "InvalidDigest",
  "EntityTooLarge",
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
] as const;
type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];
const STORAGE_ERROR_MARKER = "__HACKERAI_UPLOAD_STORAGE_CODE__:";
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** POSIX curl PUT with a private, transient response file. Never print its body.
 * If diagnostic tools/storage are unavailable, preserve the ordinary upload.
 */
export function buildPosixCurlUploadCommand(
  path: string,
  url: string,
  contentType: string,
): string {
  const request = `-X PUT -H ${quote(`Content-Type: ${contentType}`)} --data-binary @${quote(path)} ${quote(url)}`;
  const ordinaryUpload = `curl -fsSL ${request} -o /dev/null`;
  // FD 4 streams the response through a bounded, best-effort file sink. Always
  // drain the rest so a failed diagnostic write cannot cause curl's EPIPE/23.
  // FD 3 returns HTTP status and curl exit status independently of that sink.
  return `(
case "$(command -v curl)" in
  */snap/bin/curl)
    ${ordinaryUpload}
    exit $?
    ;;
esac
if [ ! -d /dev/fd ] || ! command -v mktemp >/dev/null 2>&1 || ! command -v head >/dev/null 2>&1 || ! command -v sed >/dev/null 2>&1 || ! command -v cat >/dev/null 2>&1 || ! command -v rm >/dev/null 2>&1; then
  ${ordinaryUpload}
  exit $?
fi
response_file=$(umask 077; mktemp "\${TMPDIR:-/tmp}/hackerai-upload-response.XXXXXXXX" 2>/dev/null) || {
  ${ordinaryUpload}
  exit $?
}
trap 'rm -f -- "$response_file"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
curl_result=$(
  {
    {
      curl_exit=0
      http_status=$(curl -sSL -o /dev/fd/4 -w '%{http_code}' ${request}) || curl_exit=$?
      printf '%s %s' "$http_status" "$curl_exit" >&3
    } 4>&1 |
    { head -c 8192 > "$response_file"; cat >/dev/null; } 2>/dev/null
  } 3>&1
)
http_status=\${curl_result% *}
curl_exit=\${curl_result##* }
if [ "$curl_exit" -ne 0 ]; then exit "$curl_exit"; fi
case "$http_status" in
  [45][0-9][0-9])
    storage_code=$(LC_ALL=C head -c 8192 "$response_file" 2>/dev/null | LC_ALL=C sed -nE 's@.*<Code>(${STORAGE_ERROR_CODES.join("|")})</Code>.*@\\1@p' | head -n 1)
    printf 'curl: (22) The requested URL returned error: %s\\n' "$http_status" >&2
    printf '${STORAGE_ERROR_MARKER}%s\\n' "\${storage_code:-Unknown}" >&2
    exit 22
    ;;
esac
)`;
}

/** Bounded diagnostics only: never return a URL, signing material or error text. */
export function getUploadFailureDiagnostics(
  uploadUrl: string,
  error: unknown,
  now = Date.now(),
) {
  const fields: {
    upload_reported_http_status: number | null;
    upload_reported_storage_code: StorageErrorCode | null;
    upload_storage_diagnostic_present: boolean;
    upload_signature_age_ms: number | null;
    upload_signature_ttl_ms: number | null;
    upload_signature_remaining_ms: number | null;
  } = {
    upload_reported_http_status: null,
    upload_reported_storage_code: null,
    upload_storage_diagnostic_present: false,
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
      new RegExp(
        `^(?:Failed to upload file: )?curl: \\(22\\) The requested URL returned error: ([45]\\d{2})(?:\\r?\\n${STORAGE_ERROR_MARKER}(${STORAGE_ERROR_CODES.join("|")}|Unknown))?(?:\\r?\\n)?$`,
      ),
    );
    if (status) {
      fields.upload_reported_http_status = Number(status[1]);
      fields.upload_storage_diagnostic_present = status[2] !== undefined;
      if (status[2] && status[2] !== "Unknown")
        fields.upload_reported_storage_code = status[2] as StorageErrorCode;
    }
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
