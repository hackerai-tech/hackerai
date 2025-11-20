import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
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
