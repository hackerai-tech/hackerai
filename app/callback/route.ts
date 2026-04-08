import { handleAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const isValidLocalPath = (path: string): boolean => {
  return (
    path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
  );
};

type RecoveryBucket =
  | "state_mismatch"
  | "verifier_missing"
  | "cookie_missing"
  | "unknown";

const classifyCallbackError = (error: unknown): RecoveryBucket => {
  if (!(error instanceof Error)) return "unknown";
  if (error.message.includes("OAuth state mismatch")) return "state_mismatch";
  if (error.message.includes("Auth cookie missing")) return "cookie_missing";
  if (error.name === "ValiError") {
    const issues = (error as Error & { issues?: Array<{ expected?: string }> })
      .issues;
    if (
      issues?.some((i) =>
        ['"nonce"', '"codeVerifier"'].includes(i.expected ?? ""),
      )
    ) {
      return "verifier_missing";
    }
  }
  return "unknown";
};

const buildRecoveryResponse = async (
  request: NextRequest,
  error: unknown,
): Promise<Response> => {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;
  const hasVerifierCookie = request.cookies.has("wos-auth-verifier");
  if (redirectPath) cookieStore.delete("post_login_redirect");

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
    bucket,
    hasVerifierCookie,
    userAgent: request.headers.get("user-agent"),
    refererOrigin,
    secFetchSite: request.headers.get("sec-fetch-site"),
  };

  if (bucket === "unknown") {
    console.error("[AuthKit callback error]", error, logPayload);
    return NextResponse.redirect(new URL("/auth-error?code=500", request.url));
  }

  console.warn("[AuthKit callback recovery]", logPayload);

  // Only verifier_missing with the cookie still present indicates genuine
  // corruption/tampering worth surfacing as an error. Everything else →
  // one-click recovery via /login.
  if (bucket === "verifier_missing" && hasVerifierCookie) {
    return NextResponse.redirect(
      new URL("/auth-error?code=400&reason=verifier_invalid", request.url),
    );
  }

  // Recoverable cases (stale flow, multi-tab, scanner prefetch, ITP,
  // cross-device link, embedded webview, missing cookie): one-click recovery.
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

// AsyncLocalStorage-free handoff: the onError handler runs synchronously
// within the same request's authHandler invocation, so stashing the current
// request on a module-level variable immediately before the call is safe
// for a single in-flight request per isolate.
let currentRequest: NextRequest | null = null;

const authHandler = handleAuth({
  onError: async ({ error }) => {
    // Authkit catches all callback errors and, by default, logs them via
    // console.error and returns a generic 500. Override that path so we can
    // classify and redirect users to a recoverable flow instead.
    if (!currentRequest) {
      console.error("[AuthKit callback error]", error);
      return new Response(null, {
        status: 302,
        headers: { Location: "/auth-error?code=500" },
      });
    }
    return buildRecoveryResponse(currentRequest, error);
  },
});

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;

  currentRequest = request;
  let response: Response;
  try {
    response = await authHandler(request);
  } catch (error) {
    // Defensive: handleAuth shouldn't throw when onError is provided, but if
    // it ever does, fall back to the same recovery pipeline.
    return buildRecoveryResponse(request, error);
  } finally {
    currentRequest = null;
  }

  // On success, honor post_login_redirect.
  if (
    redirectPath &&
    isValidLocalPath(redirectPath) &&
    [302, 307].includes(response.status)
  ) {
    cookieStore.delete("post_login_redirect");
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }

  if (response.status >= 400) {
    return NextResponse.redirect(
      new URL(`/auth-error?code=${response.status}`, request.url),
    );
  }

  return response;
}
