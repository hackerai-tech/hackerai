import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

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

const unauthenticatedPaths = [
  "/",
  "/login",
  "/signup",
  "/logout",
  "/api/clear-auth-cookies",
  "/api/auth/desktop-callback",
  "/callback",
  "/desktop-login",
  "/desktop-callback",
  "/privacy-policy",
  "/terms-of-service",
  "/manifest.json",
  "/share/:path*",
];

const workosMiddleware = authkitMiddleware({
  redirectUri: getRedirectUri(),
  eagerAuth: true,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths,
  },
});

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  if (isDesktopApp(request)) {
    const hasSession = request.cookies.has("wos-session");
    const pathname = request.nextUrl.pathname;

    const isUnauthenticatedPath = unauthenticatedPaths.some((path) => {
      if (path.endsWith(":path*")) {
        const prefix = path.replace(":path*", "");
        return pathname.startsWith(prefix);
      }
      return pathname === path;
    });

    if (!hasSession && !isUnauthenticatedPath) {
      return NextResponse.redirect(
        new URL("/desktop-callback?error=unauthenticated", request.url),
      );
    }
  }

  return workosMiddleware(request, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
