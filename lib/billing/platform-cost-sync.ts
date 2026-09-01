import { timingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type {
  PlatformCostRow,
  PlatformVendor,
} from "@/lib/billing/platform-costs";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;

export type CostSyncResult = {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
};

export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function logCostSync(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "platform-cost-sync",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

export function safeError(error: unknown) {
  return error instanceof Error
    ? { error_name: error.name, error_message: error.message }
    : { error_name: "UnknownError", error_message: "Unknown error" };
}

class NonRetryableUpstreamError extends Error {}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 10_000);
  }
  return 250 * 2 ** (attempt - 1);
}

export async function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return await consume(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        throw new NonRetryableUpstreamError(
          `Upstream request failed with status ${response.status}`,
        );
      }
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw new Error(
          `Upstream request failed with status ${response.status}`,
        );
      }
      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelay(response, attempt)),
      );
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableUpstreamError) throw error;
      if (attempt === MAX_FETCH_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * 2 ** (attempt - 1)),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Upstream request failed");
}

export async function replaceCostWindow(args: {
  vendor: PlatformVendor;
  startDay: string;
  endDay: string;
  observedAt: number;
  rows: PlatformCostRow[];
}): Promise<CostSyncResult> {
  const convexUrl = requireEnvironment("NEXT_PUBLIC_CONVEX_URL");
  const serviceKey = requireEnvironment("CONVEX_SERVICE_ROLE_KEY");
  const convex = new ConvexHttpClient(convexUrl);
  return await convex.mutation(api.platformCosts.replaceVendorCostWindow, {
    serviceKey,
    ...args,
  });
}
