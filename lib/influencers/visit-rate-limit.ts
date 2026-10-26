import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createRedisClient } from "@/lib/rate-limit/redis";

const WINDOW_SECONDS = 60;
const SOURCE_LIMIT = 30;
const GLOBAL_LIMIT = 300;

// Both counters are reserved together. Rejected traffic neither consumes the
// other allowance nor creates more source keys after the global budget is full.
const ADMIT_VISIT_SCRIPT = `
local sourceCount = tonumber(redis.call("GET", KEYS[1]) or "0")
local globalCount = tonumber(redis.call("GET", KEYS[2]) or "0")
if sourceCount >= tonumber(ARGV[1]) or globalCount >= tonumber(ARGV[2]) then
  return 0
end
for _, key in ipairs(KEYS) do
  if redis.call("INCR", key) == 1 then
    redis.call("EXPIRE", key, tonumber(ARGV[3]))
  end
end
return 1
`;

function sourceAddress(headers: Headers): string {
  // Client-supplied forwarding headers are not identities on other hosts.
  if (process.env.VERCEL !== "1") return "unknown";
  const address = headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  if (isIP(address) === 4) return address;
  if (isIP(address) === 6) {
    try {
      return new URL(`http://[${address}]/`).hostname;
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/** Admit optional anonymous visit analytics; failure must not block attribution. */
export async function allowInfluencerVisitAnalytics(
  request: Pick<Request, "headers">,
): Promise<boolean> {
  try {
    const redis = createRedisClient();
    const secret = process.env.WORKOS_COOKIE_PASSWORD;
    if (!redis || !secret) return false;

    const window = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const environment =
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
    const prefix = `influencer_visits:v1:${environment}:${window}`;
    // Domain separation and a rotating window keep raw network addresses out of
    // Redis and avoid creating a persistent identifier across visit windows.
    const source = createHmac("sha256", secret)
      .update(`${prefix}:${sourceAddress(request.headers)}`)
      .digest("hex");
    return (
      (await redis.eval(
        ADMIT_VISIT_SCRIPT,
        [`${prefix}:source:${source}`, `${prefix}:global`],
        [SOURCE_LIMIT, GLOBAL_LIMIT, WINDOW_SECONDS * 2],
      )) === 1
    );
  } catch {
    // Analytics is optional. Missing or failed admission must not reopen the
    // durable-write/flush path, or produce one log entry per abusive request.
    return false;
  }
}
