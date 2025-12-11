import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

function getRedirectUri(): string | undefined {
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/callback`;
  }
  return undefined;
}

export default authkitMiddleware({
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
      "/privacy-policy",
      "/terms-of-service",
      "/manifest.json",
      "/share/:path*", // Allow public access to shared chats
    ],
  },
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
