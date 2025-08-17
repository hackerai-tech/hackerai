import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";
import { isWorkOSEnabled } from "@/lib/auth-utils";

// If WorkOS is configured, use authkit middleware
// Otherwise, just pass through requests
const middleware = isWorkOSEnabled()
  ? authkitMiddleware({
      middlewareAuth: {
        enabled: true,
        unauthenticatedPaths: [
          "/",
          "/login",
          "/signup",
          "/logout",
          "/callback",
          "/privacy-policy",
          "/terms-of-service",
        ],
      },
    })
  : (request: NextRequest) => {
      // No authentication required, just pass through
      return NextResponse.next();
    };

export default middleware;

// Match against pages that require authentication
// Leave this out if you want authentication on every page in your application
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png).*)",
  ],
};
