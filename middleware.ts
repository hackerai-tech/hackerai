import { authkit } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse, NextFetchEvent } from "next/server";
import { isRateLimitError } from "@/lib/api/response";

const UNAUTHENTICATED_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/logout",
  "/api/clear-auth-cookies",
  "/api/auth/desktop-callback",
  "/api/extra-usage/webhook",
  "/api/fraud/webhook",
  "/api/subscription/webhook",
  "/callback",
  "/desktop-login",
  "/desktop-callback",
  "/auth-error",
  "/privacy-policy",
  "/terms-of-service",
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
  return false;
}

function isBrowserRequest(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

const SESSION_HEADER = "x-workos-session";
const ATTRIBUTION_COOKIE = "hai_attribution";
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
] as const;

function sanitizedLandingPage(request: NextRequest): string {
  const params = new URLSearchParams();
  for (const key of ATTRIBUTION_KEYS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) params.set(key, value.slice(0, 500));
  }

  const query = params.toString();
  return query
    ? `${request.nextUrl.pathname}?${query}`
    : request.nextUrl.pathname;
}

function sanitizedReferrer(request: NextRequest): string | undefined {
  const raw = request.headers.get("referer");
  if (!raw) return undefined;

  try {
    const referrer = new URL(raw);
    return `${referrer.origin}${referrer.pathname}`.slice(0, 500);
  } catch {
    return undefined;
  }
}

function withAttributionCookie(
  request: NextRequest,
  response: NextResponse,
): NextResponse {
  if (!isBrowserRequest(request)) return response;

  const incoming: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) incoming[key] = value.slice(0, 500);
  }

  const hasNewAttribution = Object.keys(incoming).length > 0;
  const existingCookie = request.cookies.get(ATTRIBUTION_COOKIE)?.value;
  if (!hasNewAttribution && existingCookie) return response;

  let existing: Record<string, string> = {};
  if (existingCookie) {
    try {
      existing = JSON.parse(decodeURIComponent(existingCookie));
    } catch {
      existing = {};
    }
  }

  const payload = {
    ...existing,
    ...incoming,
    landing_page: existing.landing_page ?? sanitizedLandingPage(request),
    referrer: existing.referrer ?? sanitizedReferrer(request),
  };

  response.cookies.set(
    ATTRIBUTION_COOKIE,
    encodeURIComponent(JSON.stringify(payload)),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 90 * 24 * 60 * 60,
      path: "/",
    },
  );
  return response;
}

export default async function middleware(
  request: NextRequest,
  _event: NextFetchEvent,
) {
  const pathname = request.nextUrl.pathname;

  // Desktop app: redirect unauthenticated users to desktop-specific error page
  if (isDesktopApp(request)) {
    const hasSession = request.cookies.has("wos-session");

    if (!hasSession && !isUnauthenticatedPath(pathname)) {
      return withAttributionCookie(
        request,
        NextResponse.redirect(
          new URL("/desktop-callback?error=unauthenticated", request.url),
        ),
      );
    }
  }

  let refreshHitRateLimit = false;
  const hadSessionCookie = request.cookies.has("wos-session");

  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getRedirectUri(),
    eagerAuth: true,
    onSessionRefreshError: ({ error }) => {
      if (isRateLimitError(error)) {
        refreshHitRateLimit = true;
        console.warn(
          "[Auth Middleware] WorkOS rate limit hit during session refresh",
        );
      }
    },
  });

  const requestHeaders = buildRequestHeaders(request, headers);
  const responseHeaders = buildResponseHeaders(headers);

  if (session.user || isUnauthenticatedPath(pathname)) {
    return withAttributionCookie(
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
      return withAttributionCookie(
        request,
        NextResponse.json(
          { code: "rate_limited", message: "Please retry shortly." },
          { status: 503, headers: rateLimitHeaders },
        ),
      );
    }
    // For browser requests, let through rather than forcing a confusing login redirect
    return withAttributionCookie(
      request,
      NextResponse.next({
        request: { headers: requestHeaders },
        headers: responseHeaders,
      }),
    );
  }

  if (!isBrowserRequest(request)) {
    return withAttributionCookie(
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
    console.error("[Auth Middleware] authorizationUrl unavailable", {
      pathname,
      hasSession: !!session.user,
    });
    const errorUrl = new URL("/auth-error", request.url);
    errorUrl.searchParams.set("code", "503");
    return withAttributionCookie(
      request,
      NextResponse.redirect(errorUrl, { headers: responseHeaders }),
    );
  }

  return withAttributionCookie(
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
