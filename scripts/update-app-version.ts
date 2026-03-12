/**
 * Postbuild script: updates the app_version table in Convex with the current build id.
 * Runs after `next build` during Vercel deployment.
 *
 * Required env vars:
 *   NEXT_PUBLIC_CONVEX_URL  - Convex deployment URL
 *   CONVEX_SERVICE_ROLE_KEY - Service key for authenticated mutations
 *   VERCEL_GIT_COMMIT_SHA   - Injected by Vercel (falls back to VERCEL_DEPLOYMENT_ID)
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID;

if (!convexUrl || !serviceKey || !buildId) {
  console.log(
    "[update-app-version] Skipping: missing NEXT_PUBLIC_CONVEX_URL, CONVEX_SERVICE_ROLE_KEY, or build id env var (expected in production Vercel builds).",
  );
  process.exit(0);
}

async function main(url: string, key: string, id: string) {
  const convex = new ConvexHttpClient(url);
  await convex.mutation(api.appVersion.setAppVersion, {
    serviceKey: key,
    buildId: id,
  });
  console.log(`[update-app-version] Set build_id to ${id.slice(0, 12)}...`);
}

main(convexUrl, serviceKey, buildId).catch((err) => {
  console.warn(
    "[update-app-version] Failed to update app version (non-fatal):",
    err,
  );
  process.exit(0);
});
