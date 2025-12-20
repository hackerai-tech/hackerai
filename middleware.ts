import { authkit } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

const UNAUTHENTICATED_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/logout",
  "/api/clear-auth-cookies",
  "/callback",
  "/auth-error",
  "/privacy-policy",
  "/terms-of-service",
  "/manifest.json",
]);

function getRedirectUri(): string | undefined {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/callback`;
  }
  return undefined;
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

export default async function middleware(request: NextRequest) {
  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getRedirectUri(),
    eagerAuth: true,
  });

  const pathname = request.nextUrl.pathname;
  const requestHeaders = buildRequestHeaders(request, headers);
  const responseHeaders = buildResponseHeaders(headers);

  if (session.user || isUnauthenticatedPath(pathname)) {
    return NextResponse.next({
      request: { headers: requestHeaders },
      headers: responseHeaders,
    });
  }

  if (!isBrowserRequest(request)) {
    return NextResponse.json(
      {
        code: "unauthorized:auth",
        message: "You need to sign in before continuing.",
        cause: "Session expired or invalid",
      },
      { status: 401, headers: responseHeaders }
    );
  }

  return NextResponse.redirect(authorizationUrl!, { headers: responseHeaders });
}

function buildRequestHeaders(request: NextRequest, authkitHeaders: Headers): Headers {
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
