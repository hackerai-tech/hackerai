import type { NextConfig } from "next";

const hasPostHogSourceMapApiKey = Boolean(process.env.POSTHOG_CLI_API_KEY);
const hasPostHogSourceMapProjectId = Boolean(
  process.env.POSTHOG_CLI_PROJECT_ID,
);
const posthogSourceMapsEnabled =
  hasPostHogSourceMapApiKey && hasPostHogSourceMapProjectId;

if (
  (hasPostHogSourceMapApiKey || hasPostHogSourceMapProjectId) &&
  !posthogSourceMapsEnabled
) {
  console.warn(
    "[PostHog] Source maps are disabled. Set both POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID to enable upload.",
  );
}

const nextConfig: NextConfig = {
  devIndicators: false,
  productionBrowserSourceMaps: posthogSourceMapsEnabled,
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
  ...(process.env.NODE_ENV === "development" && {
    logging: {
      serverFunctions: false,
    },
  }),
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
      },
      // Convex storage domains (more specific patterns for better performance)
      {
        protocol: "https",
        hostname: "*.convex.cloud",
      },
      {
        protocol: "https",
        hostname: "*.convex.dev",
      },
      // Fallback for other external images
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
