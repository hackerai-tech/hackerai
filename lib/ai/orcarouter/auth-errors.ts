/**
 * Connect outcomes shared by the server callback and the client toast. The
 * messages never embed codes, verifiers, keys or upstream response bodies.
 */
export type OrcaRouterAuthErrorKind =
  | "access_denied"
  | "state_mismatch"
  | "missing_code"
  | "invalid_code"
  | "method_rejected"
  | "rate_limited"
  | "insufficient_scope"
  | "malformed_response"
  | "network";

const USER_MESSAGES: Record<OrcaRouterAuthErrorKind, string> = {
  access_denied: "OrcaRouter authorization was cancelled.",
  state_mismatch:
    "The OrcaRouter sign-in response did not match this attempt. Start Connect again.",
  missing_code: "OrcaRouter did not return an authorization code.",
  invalid_code:
    "The OrcaRouter authorization code expired or was already used. Start Connect again.",
  method_rejected: "OrcaRouter rejected the PKCE challenge method.",
  rate_limited:
    "OrcaRouter has issued too many sign-in keys recently. Try again later or paste an API key.",
  insufficient_scope:
    "OrcaRouter granted less access than HackerAI needs. Reconnect with an account that can create API keys.",
  malformed_response: "OrcaRouter returned an unexpected sign-in response.",
  network: "Could not reach OrcaRouter. Check your connection and try again.",
};

export class OrcaRouterAuthError extends Error {
  readonly kind: OrcaRouterAuthErrorKind;

  constructor(kind: OrcaRouterAuthErrorKind) {
    super(USER_MESSAGES[kind]);
    this.name = "OrcaRouterAuthError";
    this.kind = kind;
  }
}

export const isOrcaRouterAuthErrorKind = (
  value: unknown,
): value is OrcaRouterAuthErrorKind =>
  typeof value === "string" && Object.hasOwn(USER_MESSAGES, value);

export const getOrcaRouterAuthErrorMessage = (kind: OrcaRouterAuthErrorKind) =>
  USER_MESSAGES[kind];
