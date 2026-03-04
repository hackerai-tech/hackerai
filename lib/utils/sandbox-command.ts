// Production Convex URL (must match @hackerai/local@latest package)
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Add --convex-url flag if running against non-production backend
export const convexUrlFlag =
  process.env.NEXT_PUBLIC_CONVEX_URL &&
  process.env.NEXT_PUBLIC_CONVEX_URL !== PRODUCTION_CONVEX_URL
    ? ` --convex-url ${process.env.NEXT_PUBLIC_CONVEX_URL}`
    : "";

// Use local path in dev (next dev), npx in production/preview
export const runCommand =
  process.env.NODE_ENV === "development"
    ? "node packages/local/dist/index.js"
    : "npx @hackerai/local@latest";
