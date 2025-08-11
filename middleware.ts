import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

// In middleware auth mode, each page is protected by default.
// Exceptions are configured via the `unauthenticatedPaths` option.
export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/login", "/callback"],
  },
});

// Match against pages that require authentication
// Leave this out if you want authentication on every page in your application
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
