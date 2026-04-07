import { handleAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const authHandler = handleAuth();

const isValidLocalPath = (path: string): boolean => {
  return (
    path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
  );
};

type RecoveryBucket = "state_mismatch" | "verifier_missing" | "unknown";

const classifyCallbackError = (error: unknown): RecoveryBucket => {
  if (!(error instanceof Error)) return "unknown";
  if (error.message.includes("OAuth state mismatch")) return "state_mismatch";
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

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;
  const hasVerifierCookie = request.cookies.has("wos-auth-verifier");

  if (redirectPath) cookieStore.delete("post_login_redirect");

  let response: Response;
  try {
    // Authkit returns error responses for most failures, but throws synchronously
    // when the wos-auth-verifier cookie is missing/corrupt — catch those here so
    // the user gets a recoverable redirect instead of a 500.
    response = await authHandler(request);
  } catch (error) {
    const bucket = classifyCallbackError(error);
    const logPayload = {
      bucket,
      hasVerifierCookie,
      userAgent: request.headers.get("user-agent"),
      referer: request.headers.get("referer"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    };

    if (bucket === "unknown") {
      console.error("[AuthKit callback error]", error, logPayload);
      return NextResponse.redirect(
        new URL("/auth-error?code=500", request.url),
      );
    }

    console.warn("[AuthKit callback recovery]", logPayload);

    // Verifier cookie present but invalid → genuine corruption / tampering;
    // don't bounce back into a login loop.
    if (hasVerifierCookie) {
      return NextResponse.redirect(
        new URL("/auth-error?code=400&reason=verifier_invalid", request.url),
      );
    }

    // Verifier cookie missing (stale flow, multi-tab, scanner prefetch, ITP,
    // cross-device link, embedded webview): one-click recovery via /login.
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
  }

  if (
    redirectPath &&
    isValidLocalPath(redirectPath) &&
    [302, 307].includes(response.status)
  ) {
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }

  if (response.status >= 400) {
    return NextResponse.redirect(
      new URL(`/auth-error?code=${response.status}`, request.url),
    );
  }

  return response;
}
