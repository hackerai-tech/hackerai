import { NextResponse } from "next/server";

/**
 * Returns the current deployment build id (e.g. Vercel's VERCEL_GIT_COMMIT_SHA).
 * Used by the client to detect when a new production deployment is live and prompt a refresh.
 */
export async function GET() {
  const buildId =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    "dev";
  return NextResponse.json({ buildId });
}
