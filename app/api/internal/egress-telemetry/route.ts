import { NextResponse, type NextRequest } from "next/server";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  ingestTelemetryBatch,
  MAX_TELEMETRY_BODY_BYTES,
  TELEMETRY_REGIONS,
  telemetryBatchSchema,
  telemetryKey,
  verifyTelemetrySignature,
} from "@/lib/cloud-network/egress-telemetry";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 15;
export const runtime = "nodejs";

// Write-only collector endpoint. It bypasses AuthKit (see proxy.ts) and
// authenticates each upload with its region's telemetry key. Responses carry
// only a fixed status, never stored counts or identities.
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

class BodyTooLargeError extends Error {}

function json(body: { status?: string; error?: string }, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function audit(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | null> = {},
) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "hackerai-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    ...fields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}

/** Bounded read, including chunked bodies without a Content-Length. */
async function readBoundedBody(request: NextRequest): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TELEMETRY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: NextRequest) {
  const region = request.headers.get("x-hackerai-egress-region");
  if (!TELEMETRY_REGIONS.some((known) => known === region)) {
    audit("warn", "egress_telemetry_rejected", { reason: "region" });
    return json({ error: "unauthorized" }, 401);
  }
  const telemetryRegion = region as (typeof TELEMETRY_REGIONS)[number];
  const key = telemetryKey(telemetryRegion);
  if (!key) {
    audit("error", "egress_telemetry_misconfigured", {
      region: telemetryRegion,
    });
    return json({ error: "telemetry_unavailable" }, 503);
  }
  const length = request.headers.get("content-length");
  if (
    length &&
    /^\d+$/.test(length) &&
    Number(length) > MAX_TELEMETRY_BODY_BYTES
  )
    return json({ error: "payload_too_large" }, 413);

  let body: Uint8Array;
  try {
    body = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return json({ error: "payload_too_large" }, 413);
    return json({ error: "invalid_request" }, 400);
  }
  const now = Date.now();
  if (
    !verifyTelemetrySignature({
      key,
      region: telemetryRegion,
      timestamp: request.headers.get("x-hackerai-egress-timestamp"),
      signature: request.headers.get("x-hackerai-egress-signature"),
      body,
      nowMs: now,
    })
  ) {
    audit("warn", "egress_telemetry_rejected", {
      region: telemetryRegion,
      reason: "signature",
    });
    return json({ error: "unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const parsed = telemetryBatchSchema.safeParse(payload);
  if (!parsed.success || parsed.data.region !== telemetryRegion) {
    audit("warn", "egress_telemetry_rejected", {
      region: telemetryRegion,
      reason: "schema",
    });
    return json({ error: "invalid_payload" }, 400);
  }

  const redis = createRedisClient();
  if (!redis) {
    audit("error", "egress_telemetry_misconfigured", {
      region: telemetryRegion,
    });
    return json({ error: "telemetry_unavailable" }, 503);
  }
  let outcome: Awaited<ReturnType<typeof ingestTelemetryBatch>>;
  try {
    outcome = await ingestTelemetryBatch(redis, parsed.data, body, now);
  } catch {
    audit("error", "egress_telemetry_store_failed", {
      region: telemetryRegion,
    });
    return json({ error: "telemetry_unavailable" }, 503);
  }
  if (outcome === "conflict") {
    audit("warn", "egress_telemetry_rejected", {
      region: telemetryRegion,
      reason: "conflict",
    });
    return json({ error: "batch_conflict" }, 409);
  }
  // One receipt per stored, retried or stale region-minute, so a missing
  // heartbeat can be told apart from a late or never-received upload.
  const minute = parsed.data.minute;
  const minuteStart = new Date(minute * 60_000);
  audit("info", "egress_telemetry_received", {
    region: telemetryRegion,
    minute,
    minuteStart: Number.isNaN(minuteStart.getTime())
      ? null
      : minuteStart.toISOString(),
    outcome,
    delayAfterMinuteEndS: Math.round((now - (minute + 1) * 60_000) / 1000),
  });
  // A stale batch is acknowledged so the collector can drop it.
  return json({ status: outcome });
}
