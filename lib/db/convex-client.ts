import type { ConvexHttpClient } from "convex/browser";
import { ChatSDKError } from "@/lib/errors";
import { createServiceConvexClient } from "@/lib/db/service-client";

// Shared singleton so Trigger.dev's setConvexUrl() override reaches every
// caller. Lazy-init the client so this module is safe to import from code
// paths that Convex's deploy bundler analyzes (e.g.
// convex/rateLimitStatus → lib/rate-limit/token-bucket → lib/extra-usage);
// constructing ConvexHttpClient eagerly with the empty URL the analyzer
// sees would fail validation and break `convex deploy`.

let client: ConvexHttpClient | null = null;
let overrideUrl: string | undefined;

export function getConvexUrl(): string {
  const url = overrideUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  }
  return url;
}

export function getConvexClient(signal?: AbortSignal): ConvexHttpClient {
  // A scoped reader must not change the singleton's fetch/cancellation options.
  if (signal) return createServiceConvexClient(getConvexUrl(), { signal });
  if (!client) {
    client = createServiceConvexClient(getConvexUrl());
  }
  return client;
}

/**
 * A caller-owned client whose transport and helper retry sleeps share one
 * deadline. Its SDK mutation queue belongs to that caller alone, so an
 * unrelated pending write on the process singleton cannot delay it.
 */
export type ConvexCallScope = {
  client: ConvexHttpClient;
  signal: AbortSignal;
};

const LOST_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * True when an RPC may have reached Convex but its response was lost: a
 * deadline/abort, a reset connection or a terminated body. Convex function
 * errors, validation failures and returned business outcomes are excluded:
 * those responses arrived, so their outcome is known.
 */
export function isConvexOutcomeUnknownError(error: unknown): boolean {
  if (error instanceof ChatSDKError)
    return error.metadata?.db_outcome_unknown === true;
  if (!error || typeof error !== "object") return false;
  const { name, message, code, cause } = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  if (name === "TimeoutError" || name === "AbortError") return true;
  const causeCode =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown }).code
      : undefined;
  if (
    (typeof code === "string" && LOST_TRANSPORT_CODES.has(code)) ||
    (typeof causeCode === "string" && LOST_TRANSPORT_CODES.has(causeCode))
  )
    return true;
  return (
    name === "TypeError" &&
    (message === "fetch failed" || message === "terminated")
  );
}

// Called by Trigger.dev tasks to point at the correct per-branch preview
// deployment. The Trigger.dev process's NEXT_PUBLIC_CONVEX_URL only reflects
// what the dashboard has configured, so the route forwards the right URL via
// the task payload and the task calls this. Each Trigger.dev run is an
// isolated worker process so mutation is safe.
export function setConvexUrl(url: string) {
  overrideUrl = url;
  client = createServiceConvexClient(url);
}
