import type { NextRequest } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  isAuthorizationChallengeOrigin,
  MAX_AUTHORIZATION_CHALLENGE_BODY_BYTES,
  parseNativeAuthorizationChallenge,
} from "@/lib/desktop/authorization-challenge-diagnostic";

export const runtime = "nodejs";

/** Support-only, private; never read by any route. */
const KEY_PREFIX = "support:desktop-authorization-challenge:v1:";
const RATE_KEY_PREFIX = "support:desktop-authorization-challenge-rate:v1:";
const MAX_RECORDS = 16;
const RETENTION_SECONDS = 24 * 60 * 60;
const MAX_UPLOADS_PER_WINDOW = 16;
const UPLOAD_WINDOW_SECONDS = 60;
/** Native and server clocks may disagree; a record is uploaded at once. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Enforce the per-account upload budget and append in one Redis round trip.
 * Rejected uploads leave both the counter and the private receipt list alone.
 * Later writes never extend the list's initial expiry.
 */
const APPEND_SCRIPT = `local uploads = tonumber(redis.call('GET', KEYS[2]) or '0')
if uploads >= tonumber(ARGV[4]) then return 0 end
if redis.call('INCR', KEYS[2]) == 1 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
end
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
return 1`;

const status = (code: number) =>
  new Response(null, {
    status: code,
    headers: { "Cache-Control": "no-store" },
  });

/** Reads at most `max` bytes; a longer or unreadable body is null. */
async function readBoundedBody(
  request: Request,
  max: number,
): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decode(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Write-only: records Vercel's challenge of this user's native authorization
 * POST for support, and answers only with a status. The record holds no
 * user ID, token, IP, body or other header.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  if (
    !isAuthorizationChallengeOrigin(origin) ||
    request.headers.get("origin") !== origin
  )
    return status(403);
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return status(415);

  let userId: string;
  try {
    userId = await getUserID(request);
  } catch {
    return status(401);
  }

  const bytes = await readBoundedBody(
    request,
    MAX_AUTHORIZATION_CHALLENGE_BODY_BYTES,
  );
  if (!bytes) return status(413);
  const record = parseNativeAuthorizationChallenge(decode(bytes));
  const receivedAtMs = Date.now();
  if (
    !record ||
    record.capturedAtMs < receivedAtMs - RETENTION_SECONDS * 1000 ||
    record.capturedAtMs > receivedAtMs + MAX_CLOCK_SKEW_MS
  )
    return status(400);

  const redis = createRedisClient();
  if (!redis) return status(503);
  try {
    const result = await redis.eval<string[], 0 | 1>(
      APPEND_SCRIPT,
      [`${KEY_PREFIX}${userId}`, `${RATE_KEY_PREFIX}${userId}`],
      [
        JSON.stringify({
          version: 1,
          capturedAtMs: record.capturedAtMs,
          receivedAtMs,
          httpStatus: 403,
          method: "POST",
          host: url.hostname,
          path: "/api/desktop/authorized-operation",
          mitigation: "challenge",
          requestId: record.requestId,
          retryAfter: record.retryAfter,
        }),
        String(MAX_RECORDS),
        String(RETENTION_SECONDS),
        String(MAX_UPLOADS_PER_WINDOW),
        String(UPLOAD_WINDOW_SECONDS),
      ],
    );
    return status(result === 0 ? 429 : 204);
  } catch {
    return status(503);
  }
}
