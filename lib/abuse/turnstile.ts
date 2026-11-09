import "server-only";

export function abuseTurnstileConfig() {
  const siteKey = process.env.ABUSE_TURNSTILE_SITE_KEY?.trim();
  const secretKey = process.env.ABUSE_TURNSTILE_SECRET_KEY?.trim();
  const hostnames = (process.env.ABUSE_TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    !siteKey ||
    !secretKey ||
    !/^[a-zA-Z0-9_-]{20,256}$/.test(siteKey) ||
    !/^[a-zA-Z0-9_-]{20,256}$/.test(secretKey) ||
    // Cloudflare's published dummy keys must never enable a real intake.
    /^[123]x0{10,}/.test(siteKey) ||
    /^[123]x0{10,}/.test(secretKey) ||
    hostnames.length === 0 ||
    hostnames.length > 10 ||
    hostnames.some(
      (host) =>
        host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9-]+)*$/.test(host),
    )
  )
    return null;
  return { siteKey, secretKey, hostnames };
}

export type AbuseVerification = "verified" | "rejected" | "unavailable";

/** Challenge tokens never enter case evidence, fingerprints, logs or analytics. */
export async function verifyAbuseTurnstile(
  token: string,
  hostname: string,
): Promise<AbuseVerification> {
  const config = abuseTurnstileConfig();
  if (!config) return "unavailable";
  if (!config.hostnames.includes(hostname.toLowerCase())) return "rejected";
  if (!token || token.length > 2048) return "rejected";
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: config.secretKey, response: token }),
        cache: "no-store",
        signal: AbortSignal.timeout(7_000),
      },
    );
    if (!response.ok) return "unavailable";
    const result = await response.json();
    if (result?.success !== true) {
      return Array.isArray(result?.["error-codes"]) &&
        result["error-codes"].some((code: unknown) =>
          [
            "internal-error",
            "missing-input-secret",
            "invalid-input-secret",
          ].includes(String(code)),
        )
        ? "unavailable"
        : "rejected";
    }
    return result.hostname === hostname.toLowerCase() &&
      result.action === "abuse_report"
      ? "verified"
      : "rejected";
  } catch {
    return "unavailable";
  }
}
