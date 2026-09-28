import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OrcaRouterAuthError } from "@/lib/ai/orcarouter/auth-errors";

/**
 * OAuth 2.0 + PKCE (S256) for "Connect with OrcaRouter". The flow is a
 * redirect back to this app's own HTTPS callback, so no client secret or
 * pre-registered redirect URI is involved. The exchange returns a normal,
 * durable OrcaRouter API key owned by the user — not a refreshable token.
 */

export const ORCAROUTER_APP_NAME = "HackerAI";
export const ORCAROUTER_REQUIRED_SCOPE = "api";
export const ORCAROUTER_EXCHANGE_TIMEOUT_MS = 15_000;

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export type PkceAttempt = {
  verifier: string;
  challenge: string;
  state: string;
};

/** Fresh cryptographic randomness for every authorization attempt. */
export function createPkceAttempt(): PkceAttempt {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: createS256Challenge(verifier),
    state: base64url(randomBytes(16)),
  };
}

export function createS256Challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildOrcaRouterAuthorizeUrl({
  authOrigin,
  callbackUrl,
  challenge,
  state,
}: {
  authOrigin: string;
  callbackUrl: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL("/auth", authOrigin);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("app_name", ORCAROUTER_APP_NAME);
  url.searchParams.set("scope", ORCAROUTER_REQUIRED_SCOPE);
  return url.toString();
}

/** Constant-time comparison so the callback cannot be probed for `state`. */
export function statesMatch(expected: string, received: string | null) {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OrcaRouterExchangeResult = {
  key: string;
  scope: string;
};

export async function exchangeOrcaRouterCode({
  authOrigin,
  code,
  verifier,
  fetchImpl = fetch,
  timeoutMs = ORCAROUTER_EXCHANGE_TIMEOUT_MS,
}: {
  authOrigin: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OrcaRouterExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/v1/auth/keys", authOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new OrcaRouterAuthError("network");
  }

  if (response.status === 403) throw new OrcaRouterAuthError("invalid_code");
  if (response.status === 400) throw new OrcaRouterAuthError("method_rejected");
  if (response.status === 429) throw new OrcaRouterAuthError("rate_limited");
  if (!response.ok) throw new OrcaRouterAuthError("network");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OrcaRouterAuthError("malformed_response");
  }
  const key =
    body && typeof body === "object" ? (body as { key?: unknown }).key : null;
  const scope =
    body && typeof body === "object"
      ? (body as { scope?: unknown }).scope
      : null;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new OrcaRouterAuthError("malformed_response");
  }
  // The response scope is what was granted, which can be narrower than what
  // was requested. Inference requires the `api` grant.
  if (scope !== ORCAROUTER_REQUIRED_SCOPE) {
    throw new OrcaRouterAuthError("insufficient_scope");
  }
  return { key: key.trim(), scope };
}
