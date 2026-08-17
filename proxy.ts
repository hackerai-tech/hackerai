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
import {
  FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME,
  FIRST_TOUCH_ATTRIBUTION_MAX_AGE_SECONDS,
  createFirstTouchAttribution,
  serializeFirstTouchAttribution,
} from "@/lib/analytics/acquisition";

const AUTHKIT_BYPASS_PATHS = new Set([
  "/api/health/connectivity",
  "/api/health/core",
  "/api/health/trigger-agent-mode",
  "/robots.txt",
  "/sitemap.xml",
]);
const ROOT_PAGE_PATHS = new Set(["/", "/index"]);
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

function isUnsupportedRootPageRequest(
  request: NextRequest,
  pathname: string,
): boolean {
  if (!ROOT_PAGE_PATHS.has(pathname)) return false;
  if (request.method === "GET" || request.method === "HEAD") return false;

  return !isNextActionRequest(request);
}

function isNextActionRequest(request: NextRequest): boolean {
  return request.method === "POST" && request.headers.has(NEXT_ACTION_HEADER);
}

function isOriginParsedServerActionRequest(request: NextRequest): boolean {
  if (request.method !== "POST") return false;
  if (request.headers.has(NEXT_ACTION_HEADER)) return true;

  return (
    request.headers.get("content-type")?.startsWith("multipart/form-data") ??
    false
  );
}

function hasMalformedNextActionOrigin(request: NextRequest): boolean {
  if (!isOriginParsedServerActionRequest(request)) return false;

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  try {
    new URL(origin);
    return false;
  } catch {
    return true;
  }
}

function isBrowserRequest(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

const SESSION_HEADER = "x-workos-session";

function withAttributionCookies(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  const pathname = request.nextUrl.pathname;
  const shouldCaptureFirstTouch =
    (request.method === "GET" || request.method === "HEAD") &&
    isBrowserRequest(request) &&
    !pathname.startsWith("/api/") &&
    ![
      "/callback",
      "/logout",
      "/auth-error",
      "/desktop-callback",
      "/desktop-login",
    ].includes(pathname) &&
    !request.cookies.has("wos-session") &&
    !request.cookies.has(FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME);

  if (shouldCaptureFirstTouch) {
    response.cookies.set(
      FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME,
      serializeFirstTouchAttribution(
        createFirstTouchAttribution({
          url: request.nextUrl,
          referer: request.headers.get("referer"),
        }),
      ),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: FIRST_TOUCH_ATTRIBUTION_MAX_AGE_SECONDS,
        path: "/",
      },
    );
  }

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
  // A Server Action still runs after middleware. Letting an ended session
  // through on a public page means the action's `withAuth()` call has no
  // AuthKit middleware context and throws a misleading 500 instead of a clean
  // authentication response.
  if (isNextActionRequest(request)) {
    return withSessionCookieCleared(
      NextResponse.json(
        {
          code: "unauthorized:auth",
          message: "You need to sign in before continuing.",
          cause: "Session expired or invalid",
        },
        { status: 401 },
      ),
    );
  }

  if (isUnauthenticatedPath(pathname)) {
    return withSessionCookieCleared(
      withAttributionCookies(request, NextResponse.next()),
    );
  }

  if (!isBrowserRequest(request)) {
    return withSessionCookieCleared(
      withAttributionCookies(
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
    withAttributionCookies(request, NextResponse.redirect(redirectUrl)),
  );
}

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isUnsupportedRootPageRequest(request, pathname)) {
    return NextResponse.json(
      {
        code: "method_not_allowed",
        message: `${request.method} is not supported for this route.`,
      },
      {
        status: 405,
        headers: {
          Allow: request.method === "POST" ? "GET, HEAD" : "GET, HEAD, POST",
        },
      },
    );
  }

  // Next parses the Origin header before its Server Action CSRF comparison.
  // Reject malformed values here so an invalid client header cannot turn into
  // an unhandled URL-construction error. Well-formed cross-origin requests are
  // still left to Next's existing CSRF validation.
  if (hasMalformedNextActionOrigin(request)) {
    const requestId = request.headers.get("x-vercel-id");
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "server_action_request_rejected",
        service: "hackerai-web",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId?.slice(0, 128),
        pathname,
        reason: "malformed_origin",
      }),
    );
    return NextResponse.json(
      {
        code: "bad_request:request",
        message: "The request origin is invalid.",
      },
      { status: 400 },
    );
  }

  if (shouldBypassAuthkit(pathname)) {
    return NextResponse.next();
  }

  // Desktop app: redirect unauthenticated users to desktop-specific error page
  if (isDesktopApp(request)) {
    const hasSession = request.cookies.has("wos-session");

    if (!hasSession && !isUnauthenticatedPath(pathname)) {
      return withAttributionCookies(
        request,
        NextResponse.redirect(
          new URL("/desktop-callback?error=unauthenticated", request.url),
        ),
      );
    }
  }

  let refreshHitRateLimit = false;
  let refreshEndedSession = false;
  const hadSessionCookie = request.cookies.has("wos-session");

  let authkitResult: Awaited<ReturnType<typeof authkit>>;
  try {
    authkitResult = await authkit(request, {
      redirectUri: getRedirectUri(),
      eagerAuth: true,
      onSessionRefreshError: ({ error }) => {
        if (isEndedSessionRefreshError(error)) {
          refreshEndedSession = true;
          console.info(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "info",
              event: "auth.session_refresh_ended",
              service: "hackerai-web",
              environment:
                process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
              pathname,
            }),
          );
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

  if (refreshEndedSession) {
    return buildEndedSessionResponse(request, pathname);
  }

  const requestHeaders = buildRequestHeaders(request, headers);
  const responseHeaders = buildResponseHeaders(headers, {
    preserveSessionCookies: hadSessionCookie && refreshHitRateLimit,
  });

  if (session.user || isUnauthenticatedPath(pathname)) {
    return withAttributionCookies(
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
      return withAttributionCookies(
        request,
        NextResponse.json(
          { code: "rate_limited", message: "Please retry shortly." },
          { status: 503, headers: rateLimitHeaders },
        ),
      );
    }
    // For browser requests, let through rather than forcing a confusing login redirect
    return withAttributionCookies(
      request,
      NextResponse.next({
        request: { headers: requestHeaders },
        headers: responseHeaders,
      }),
    );
  }

  if (!isBrowserRequest(request)) {
    return withAttributionCookies(
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
    return withAttributionCookies(
      request,
      NextResponse.redirect(errorUrl, { headers: responseHeaders }),
    );
  }

  return withAttributionCookies(
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

function buildResponseHeaders(
  authkitHeaders: Headers,
  { preserveSessionCookies = false } = {},
): Headers {
  const responseHeaders = new Headers(authkitHeaders);
  responseHeaders.delete(SESSION_HEADER);

  // AuthKit clears session cookies for every refresh exception. A provider
  // rate limit is transient, so forwarding those deletions would turn a
  // recoverable retry into a logged-out session.
  if (preserveSessionCookies) {
    responseHeaders.delete("set-cookie");
  }

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
