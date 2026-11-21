import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import type { createRedisClient } from "@/lib/rate-limit/redis";
import { ATTRIBUTION_KEY_ENV, ATTRIBUTION_REF } from "./egress-attribution";

/**
 * Per-minute counts of accepted, attributed SOCKS authentications uploaded by
 * each regional proxy's collector (scripts/egress/collector.py). One batch per
 * region and minute, with a stable canonical body, so retries and replays are
 * idempotent. Exact HTTP request counts are not available from the proxy.
 */
export const TELEMETRY_REGIONS = ["us", "eu"] as const;
const KEY_ENV: Record<E2BCluster, string> = {
  us: "E2B_EGRESS_TELEMETRY_US_KEY",
  eu: "E2B_EGRESS_TELEMETRY_EU_KEY",
};
const SIGNATURE_DOMAIN = "hackerai-egress-telemetry/v1";
export const MAX_TELEMETRY_BODY_BYTES = 128 * 1024;
export const MAX_BATCH_IDENTITIES = 1000;
export const TELEMETRY_FRESHNESS_S = 300;
/** Accepted batches are kept long enough for late evaluation, not history. */
export const TELEMETRY_RETENTION_S = 2 * 60 * 60;
const MAX_BATCH_AGE_MINUTES = 24 * 60;
const KEY_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP = /^[1-9]\d{0,11}$/;

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

/**
 * A missing or malformed key disables the region, as does a key reused for
 * the other region or for attribution in the same process.
 */
export function telemetryKey(
  region: E2BCluster,
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const value = env[KEY_ENV[region]] ?? "";
  if (!KEY_HEX.test(value)) return null;
  const reused = [
    env[KEY_ENV[region === "us" ? "eu" : "us"]],
    ...ATTRIBUTION_KEY_ENV.map((name) => env[name]),
  ];
  if (reused.includes(value)) return null;
  return Buffer.from(value, "hex");
}

export function telemetrySignature(
  key: Buffer,
  region: E2BCluster,
  timestamp: string,
  body: Uint8Array,
) {
  return createHmac("sha256", key)
    .update(`${SIGNATURE_DOMAIN}\n${region}\n${timestamp}\n`)
    .update(body)
    .digest("hex");
}

/** Freshness and constant-time HMAC check, before parsing or any store write. */
export function verifyTelemetrySignature(args: {
  key: Buffer;
  region: E2BCluster;
  timestamp: string | null;
  signature: string | null;
  body: Uint8Array;
  nowMs: number;
}) {
  const { timestamp, signature } = args;
  if (!timestamp || !TIMESTAMP.test(timestamp)) return false;
  if (Math.abs(args.nowMs / 1000 - Number(timestamp)) > TELEMETRY_FRESHNESS_S)
    return false;
  const provided = SIGNATURE.exec(signature ?? "")?.[1];
  if (!provided) return false;
  const expected = telemetrySignature(
    args.key,
    args.region,
    timestamp,
    args.body,
  );
  return timingSafeEqual(
    Buffer.from(provided, "hex"),
    Buffer.from(expected, "hex"),
  );
}

const ref = z.string().regex(ATTRIBUTION_REF);
const counter = z.number().int().min(0).max(1_000_000_000);
export const telemetryBatchSchema = z
  .object({
    version: z.literal(1),
    region: z.enum(TELEMETRY_REGIONS),
    minute: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** False when the collector knows it missed events in this minute. */
    complete: z.boolean(),
    droppedEvents: counter,
    droppedBatches: counter,
    overflowConnections: counter,
    counts: z
      .array(
        z
          .object({
            owner: ref,
            workspace: ref,
            connections: counter.min(1),
          })
          .strict(),
      )
      .max(MAX_BATCH_IDENTITIES),
  })
  .strict()
  .refine(
    ({ counts }) =>
      new Set(counts.map(({ owner, workspace }) => `${owner}:${workspace}`))
        .size === counts.length,
  );
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

/** The stored minute record: the batch minus its routing fields. */
const minuteRecordSchema = z.object({
  digest: z.string(),
  complete: z.boolean(),
  droppedEvents: counter,
  droppedBatches: counter,
  overflowConnections: counter,
  counts: z.array(z.tuple([ref, ref, counter])),
});
export type TelemetryMinute = z.infer<typeof minuteRecordSchema>;

export const telemetryMinuteKey = (region: E2BCluster, minute: number) =>
  `egress-telemetry:v1:${region}:minute:${minute}`;

export type IngestOutcome = "accepted" | "duplicate" | "conflict" | "stale";

/**
 * One SET NX per (region, minute) stores the whole batch atomically. A retry
 * of the same body is a duplicate; a different body for a stored minute is a
 * conflict and never adds to the first.
 */
export async function ingestTelemetryBatch(
  redis: Redis,
  batch: TelemetryBatch,
  body: Uint8Array,
  nowMs: number,
): Promise<IngestOutcome> {
  const nowMinute = Math.floor(nowMs / 60_000);
  if (
    batch.minute > nowMinute + 1 ||
    batch.minute < nowMinute - MAX_BATCH_AGE_MINUTES
  )
    return "stale";
  const digest = createHash("sha256").update(body).digest("hex");
  const record: TelemetryMinute = {
    digest,
    complete: batch.complete,
    droppedEvents: batch.droppedEvents,
    droppedBatches: batch.droppedBatches,
    overflowConnections: batch.overflowConnections,
    counts: batch.counts.map(({ owner, workspace, connections }) => [
      owner,
      workspace,
      connections,
    ]),
  };
  const key = telemetryMinuteKey(batch.region, batch.minute);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      await redis.set(key, JSON.stringify(record), {
        nx: true,
        ex: TELEMETRY_RETENTION_S,
      })
    )
      return "accepted";
    const existing = await redis.get<{ digest?: unknown }>(key);
    if (existing === null) continue;
    return existing.digest === digest ? "duplicate" : "conflict";
  }
  throw new Error("Telemetry store unavailable");
}

/** Missing minutes stay null: absent telemetry is never read as zero. */
export async function readTelemetryMinutes(
  redis: Redis,
  region: E2BCluster,
  minutes: number[],
): Promise<(TelemetryMinute | null)[]> {
  const values = await redis.mget<unknown[]>(
    ...minutes.map((minute) => telemetryMinuteKey(region, minute)),
  );
  return values.map((value) => {
    if (value === null) return null;
    const parsed = minuteRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid stored telemetry");
    return parsed.data;
  });
}
