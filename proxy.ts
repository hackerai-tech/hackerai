import { authkit } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { isRateLimitError } from "@/lib/api/response";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";
import {
  REFERRAL_COOKIE_CREATED_AT_NAME,
  REFERRAL_COOKIE_NAME,
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";

const AUTHKIT_BYPASS_PATHS = new Set(["/api/health/trigger-agent-mode"]);
const ROOT_PAGE_POST_PATHS = new Set(["/", "/index"]);
const NEXT_ACTION_HEADER = "next-action";

const UNAUTHENTICATED_PATHS = new Set([
  ...AUTHKIT_BYPASS_PATHS,
  "/",
  "/login",
  "/signup",
  "/signup/auth",
  "/logout",
  "/api/clear-auth-cookies",
  "/api/auth/desktop-callback",
  "/api/extra-usage/webhook",
  "/api/fraud/webhook",
  "/api/subscription/webhook",
  "/api/workos/webhook",
  "/callback",
  "/desktop-login",
  "/desktop-callback",
  "/auth-error",
  "/privacy-policy",
  "/terms-of-service",
  "/trust",
  "/download",
  "/manifest.json",
]);

function getRedirectUri(): string | undefined {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/callback`;
  }
  return undefined;
}

function isDesktopApp(request: NextRequest): boolean {
  const userAgent = request.headers.get("user-agent") || "";
  return userAgent.includes("HackerAI-Desktop");
}

function isUnauthenticatedPath(pathname: string): boolean {
  if (UNAUTHENTICATED_PATHS.has(pathname)) {
    return true;
  }
  if (pathname.startsWith("/share/")) {
    return true;
  }
  if (pathname.startsWith("/invite/")) {
    return true;
  }
  return false;
}

function shouldBypassAuthkit(pathname: string): boolean {
  return AUTHKIT_BYPASS_PATHS.has(pathname);
}

function isUnsupportedRootPagePost(
  request: NextRequest,
  pathname: string,
): boolean {
  return (
    request.method === "POST" &&
    ROOT_PAGE_POST_PATHS.has(pathname) &&
    !request.headers.has(NEXT_ACTION_HEADER)
  );
}

function isBrowserRequest(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

const SESSION_HEADER = "x-workos-session";

function withReferralCookie(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  const referralCode =
    request.nextUrl.searchParams.get("referral_code") ??
    request.nextUrl.searchParams.get("ref");
  if (!referralCode || !isValidReferralCode(referralCode)) return response;

  const config = getReferralRewardConfig();
  if (!config.enabled) return response;

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: config.cookieMaxAgeSeconds,
    path: "/",
  };

  response.cookies.set(REFERRAL_COOKIE_NAME, referralCode, cookieOptions);
  response.cookies.set(
    REFERRAL_COOKIE_CREATED_AT_NAME,
    String(Date.now()),
    cookieOptions,
  );

  return response;
}

function withSessionCookieCleared(response: NextResponse): NextResponse {
  response.cookies.delete("wos-session");
  return response;
}

function buildEndedSessionResponse(
  request: NextRequest,
  pathname: string,
): NextResponse {
  if (isUnauthenticatedPath(pathname)) {
    return withSessionCookieCleared(
      withReferralCookie(request, NextResponse.next()),
    );
  }

  if (!isBrowserRequest(request)) {
    return withSessionCookieCleared(
      withReferralCookie(
        request,
        NextResponse.json(
          {
            code: "unauthorized:auth",
            message: "You need to sign in before continuing.",
            cause: "Session expired or invalid",
          },
          { status: 401 },
        ),
      ),
    );
  }

  const redirectUrl = isDesktopApp(request)
    ? new URL("/desktop-callback?error=unauthenticated", request.url)
    : new URL("/login", request.url);

  return withSessionCookieCleared(
    withReferralCookie(request, NextResponse.redirect(redirectUrl)),
  );
}

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isUnsupportedRootPagePost(request, pathname)) {
    return NextResponse.json(
      {
        code: "method_not_allowed",
        message: "POST is not supported for this route.",
      },
      { status: 405, headers: { Allow: "GET, HEAD" } },
    );
  }

  if (shouldBypassAuthkit(pathname)) {
    return NextResponse.next();
  }

  // Desktop app: redirect unauthenticated users to desktop-specific error page
  if (isDesktopApp(request)) {
    const hasSession = request.cookies.has("wos-session");

    if (!hasSession && !isUnauthenticatedPath(pathname)) {
      return withReferralCookie(
        request,
        NextResponse.redirect(
          new URL("/desktop-callback?error=unauthenticated", request.url),
        ),
      );
    }
  }

  let refreshHitRateLimit = false;
  const hadSessionCookie = request.cookies.has("wos-session");

  let authkitResult: Awaited<ReturnType<typeof authkit>>;
  try {
    authkitResult = await authkit(request, {
      redirectUri: getRedirectUri(),
      eagerAuth: true,
      onSessionRefreshError: ({ error }) => {
        if (isEndedSessionRefreshError(error)) {
          return;
        }

        if (isRateLimitError(error)) {
          refreshHitRateLimit = true;
          console.warn(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "warn",
              event: "auth.session_refresh_rate_limited",
              service: "hackerai-web",
              environment:
                process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
              pathname,
            }),
          );
          return;
        }

        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            event: "auth.session_refresh_failed",
            service: "hackerai-web",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            pathname,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    });
  } catch (error) {
    if (isEndedSessionRefreshError(error)) {
      return buildEndedSessionResponse(request, pathname);
    }
    throw error;
  }

  const { session, headers, authorizationUrl } = authkitResult;

  const requestHeaders = buildRequestHeaders(request, headers);
  const responseHeaders = buildResponseHeaders(headers);

  if (session.user || isUnauthenticatedPath(pathname)) {
    return withReferralCookie(
      request,
      NextResponse.next({
        request: { headers: requestHeaders },
        headers: responseHeaders,
      }),
    );
  }

  // If rate-limited (not a real session expiry), don't redirect to login
  if (hadSessionCookie && refreshHitRateLimit) {
    if (!isBrowserRequest(request)) {
      const rateLimitHeaders = new Headers(responseHeaders);
      rateLimitHeaders.set("Retry-After", "5");
      return withReferralCookie(
        request,
        NextResponse.json(
          { code: "rate_limited", message: "Please retry shortly." },
          { status: 503, headers: rateLimitHeaders },
        ),
      );
    }
    // For browser requests, let through rather than forcing a confusing login redirect
    return withReferralCookie(
      request,
      NextResponse.next({
        request: { headers: requestHeaders },
        headers: responseHeaders,
      }),
    );
  }

  if (!isBrowserRequest(request)) {
    return withReferralCookie(
      request,
      NextResponse.json(
        {
          code: "unauthorized:auth",
          message: "You need to sign in before continuing.",
          cause: "Session expired or invalid",
        },
        { status: 401, headers: responseHeaders },
      ),
    );
  }

  if (!authorizationUrl) {
    console.error("[Auth Proxy] authorizationUrl unavailable", {
      pathname,
      hasSession: !!session.user,
    });
    const errorUrl = new URL("/auth-error", request.url);
    errorUrl.searchParams.set("code", "503");
    return withReferralCookie(
      request,
      NextResponse.redirect(errorUrl, { headers: responseHeaders }),
    );
  }

  return withReferralCookie(
    request,
    NextResponse.redirect(authorizationUrl, { headers: responseHeaders }),
  );
}

function buildRequestHeaders(
  request: NextRequest,
  authkitHeaders: Headers,
): Headers {
  const merged = new Headers(request.headers);
  authkitHeaders.forEach((value, key) => {
    if (key.startsWith("x-")) {
      merged.set(key, value);
    }
  });
  return merged;
}

function buildResponseHeaders(authkitHeaders: Headers): Headers {
  const responseHeaders = new Headers(authkitHeaders);
  responseHeaders.delete(SESSION_HEADER);
  return responseHeaders;
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
