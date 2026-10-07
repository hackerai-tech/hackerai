import { createHash } from "node:crypto";

export type TriggerHealthConfig = {
  baseURL: string;
  token: string;
  branch: string | undefined;
};

export function getTriggerHealthConfig(): TriggerHealthConfig | undefined {
  const token =
    process.env.TRIGGER_SECRET_KEY ?? process.env.TRIGGER_ACCESS_TOKEN;
  if (!token) return undefined;
  // Match the Agent SDK's target selection. Never fall back to Production.
  return {
    token,
    baseURL: process.env.TRIGGER_API_URL ?? "https://api.trigger.dev",
    branch:
      process.env.TRIGGER_PREVIEW_BRANCH ??
      process.env.VERCEL_GIT_COMMIT_REF ??
      (process.env.TRIGGER_DEV_BRANCH === "default"
        ? undefined
        : process.env.TRIGGER_DEV_BRANCH),
  };
}

export function healthCacheKey(config: TriggerHealthConfig): string {
  // Even if environments share a Redis database, their results and leases must
  // remain separate. Rotating credentials intentionally starts with no evidence.
  const target = JSON.stringify([
    config.baseURL,
    config.token,
    config.branch ?? null,
    process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    process.env.VERCEL_PROJECT_ID ?? "local",
  ]);
  return `trigger-health:v1:${createHash("sha256").update(target).digest("hex")}`;
}
