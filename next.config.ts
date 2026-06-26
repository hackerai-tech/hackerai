import type { NextConfig } from "next";

const postHogSourceMapApiKey = process.env.POSTHOG_CLI_API_KEY?.trim();
const postHogSourceMapProjectId = process.env.POSTHOG_CLI_PROJECT_ID?.trim();
const hasPostHogSourceMapApiKey = Boolean(postHogSourceMapApiKey);
const hasPostHogSourceMapProjectId = Boolean(postHogSourceMapProjectId);
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
  async headers() {
    const iconCacheHeaders = [
      {
        key: "Cache-Control",
        value: "public, max-age=86400, stale-while-revalidate=604800",
      },
    ];

    return [
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      { source: "/favicon.ico", headers: iconCacheHeaders },
      { source: "/apple-touch-icon.png", headers: iconCacheHeaders },
      { source: "/icon-192x192.png", headers: iconCacheHeaders },
      { source: "/icon-256x256.png", headers: iconCacheHeaders },
      { source: "/icon-512x512.png", headers: iconCacheHeaders },
    ];
  },
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
