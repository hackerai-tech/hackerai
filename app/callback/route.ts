import { handleAuth } from "@workos-inc/authkit-nextjs";
import {
  isAuthVerifierMissingError,
  isAuthCookieMissingError,
  isMissingRequiredAuthParameterError,
  isOAuthStateMismatchError,
  isOauthCodeAlreadyExchangedError,
  withRecoverableAuthkitCallbackErrorSuppressed,
} from "@/lib/auth/authkit-callback-logging";
import {
  isUnverifiedSignInSessionError,
  isInvalidCodeVerifierError,
} from "@/lib/auth/expected-auth-errors";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const isValidLocalPath = (path: string): boolean => {
  return (
    path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
  );
};

const PKCE_COOKIE_PREFIX = "wos-auth-verifier";

const hasPkceCookie = (request: NextRequest): boolean =>
  request.cookies.getAll().some((c) => c.name.startsWith(PKCE_COOKIE_PREFIX));

type RecoveryBucket =
  | "missing_auth_parameter"
  | "state_mismatch"
  | "verifier_missing"
  | "cookie_missing"
  | "code_already_exchanged"
  | "invalid_code_verifier"
  | "session_unverified"
  | "unknown";

const classifyCallbackError = (error: unknown): RecoveryBucket => {
  if (isOauthCodeAlreadyExchangedError(error)) {
    return "code_already_exchanged";
  }
  if (isInvalidCodeVerifierError(error)) {
    return "invalid_code_verifier";
  }
  if (isUnverifiedSignInSessionError(error)) {
    return "session_unverified";
  }
  if (isMissingRequiredAuthParameterError(error)) {
    return "missing_auth_parameter";
  }
  if (isAuthCookieMissingError(error)) {
    return "cookie_missing";
  }
  if (isAuthVerifierMissingError(error)) {
    return "verifier_missing";
  }
  if (isOAuthStateMismatchError(error)) {
    return "state_mismatch";
  }
  return "unknown";
};

const buildRecoveryResponse = async (
  request: NextRequest,
  error: unknown,
): Promise<Response> => {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;
  const hasVerifierCookie = hasPkceCookie(request);
  if (redirectPath) {
    cookieStore.delete({ name: "post_login_redirect", path: "/" });
  }

  const bucket = classifyCallbackError(error);
  const rawReferer = request.headers.get("referer");
  let refererOrigin: string | null = null;
  if (rawReferer) {
    try {
      refererOrigin = new URL(rawReferer).origin;
    } catch {
      refererOrigin = null;
    }
  }
  const logPayload = {
    event: "auth.callback_invalid",
    bucket,
    hasVerifierCookie,
    userAgent: request.headers.get("user-agent"),
    refererOrigin,
    secFetchSite: request.headers.get("sec-fetch-site"),
  };

  // Distinct prefix from authkit's own `[AuthKit callback error]` so log
  // aggregators don't double-count and so we can grep this wrapper separately.
  if (bucket === "unknown") {
    console.error("[callback] unrecoverable", error, {
      ...logPayload,
      event: "auth.callback_failed",
    });
    return NextResponse.redirect(new URL("/auth-error?code=500", request.url));
  }

  if (bucket === "missing_auth_parameter") {
    console.info("[callback] invalid_request", logPayload);
  } else {
    console.warn("[callback] recovering", logPayload);
  }

  // Only verifier_missing with the cookie still present indicates genuine
  // corruption/tampering worth surfacing as an error. Everything else →
  // one-click recovery via /login.
  if (bucket === "verifier_missing" && hasVerifierCookie) {
    return NextResponse.redirect(
      new URL("/auth-error?code=400&reason=verifier_invalid", request.url),
    );
  }

  // Recoverable cases (stale flow, multi-tab, scanner prefetch, ITP,
  // cross-device link, embedded webview, missing cookie, duplicate callback,
  // expired sign-in session): one-click recovery.
  // Preserve post_login_redirect intent so the retry lands where they wanted.
  const loginUrl = new URL("/login", request.url);
  const loginResponse = NextResponse.redirect(loginUrl);
  if (redirectPath && isValidLocalPath(redirectPath)) {
    loginResponse.cookies.set("post_login_redirect", redirectPath, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }
  return loginResponse;
};

const authHandler = handleAuth({
  onError: async ({ error, request }) => {
    return buildRecoveryResponse(request as NextRequest, error);
  },
});

export async function GET(request: NextRequest) {
  // Short-circuit the single most common recoverable case — no PKCE cookie
  // at all (stale/abandoned flow, prefetch, ITP) — before authkit runs, so
  // authkit's unconditional `[AuthKit callback error]` console.error doesn't
  // fire. Kept intentionally minimal so it doesn't couple to authkit internals.
  if (!hasPkceCookie(request)) {
    return buildRecoveryResponse(
      request,
      new Error(
        "Auth cookie missing — cannot verify OAuth state. Ensure Set-Cookie headers are propagated on redirects.",
      ),
    );
  }

  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;

  let response: NextResponse;
  try {
    // AuthKit logs known recoverable callback failures at error level before
    // onError can hand them to our warning-level recovery path.
    response = (await withRecoverableAuthkitCallbackErrorSuppressed(() =>
      authHandler(request),
    )) as NextResponse;
  } catch (error) {
    // Defensive: handleAuth shouldn't throw when onError is provided, but if
    // it ever does, fall back to the same recovery pipeline.
    return buildRecoveryResponse(request, error);
  }

  // On a successful redirect response, always clear post_login_redirect so a
  // stale/malformed value can't survive and re-trigger the check on every
  // subsequent callback. Only rewrite the Location header if the value is a
  // safe local path. MUTATE authkit's response rather than building a new one
  // — rebuilding drops the Set-Cookie headers authkit attached to expire the
  // PKCE verifier, which causes `invalid_grant` on any subsequent hit of the
  // callback URL (refresh, back button, prefetcher).
  if (redirectPath && [302, 307].includes(response.status)) {
    cookieStore.delete({ name: "post_login_redirect", path: "/" });
    if (isValidLocalPath(redirectPath)) {
      response.headers.set(
        "location",
        new URL(redirectPath, request.url).toString(),
      );
    }
    return response;
  }

  if (response.status >= 400) {
    return NextResponse.redirect(
      new URL(`/auth-error?code=${response.status}`, request.url),
    );
  }

  return response;
}
