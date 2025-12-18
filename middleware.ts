import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextFetchEvent, NextRequest, NextResponse } from "next/server";

function getRedirectUri(): string | undefined {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/callback`;
  }
  return undefined;
}

const baseMiddleware = authkitMiddleware({
  redirectUri: getRedirectUri(),
  eagerAuth: true,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: [
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
      "/share/:path*",
    ],
  },
});

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent
) {
  const response = await baseMiddleware(request, event);

  const isRedirect = response && response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }

  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  try {
    const redirectUrl = new URL(location, request.url);
    const isAuthRedirect =
      redirectUrl.pathname === "/login" ||
      redirectUrl.hostname === "api.workos.com";

    if (!isAuthRedirect) {
      return response;
    }

    const accept = request.headers.get("accept") ?? "";
    const isBrowserNavigation = accept.includes("text/html");

    // Non-browser requests: API, fetch, RSC, Server Actions - return 401
    if (!isBrowserNavigation) {
      return NextResponse.json(
        {
          code: "unauthorized:auth",
          message: "You need to sign in before continuing.",
          cause: "Session expired or invalid",
        },
        { status: 401 }
      );
    }
  } catch {
    // URL parsing failed, let original redirect through
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
