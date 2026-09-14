import { ChatSDKError } from "../errors";
import type { Redis } from "@upstash/redis";

export const FREE_QUOTA_MIGRATION_STATE = "free_quota_gmail_migration:v1:state";
export const freeQuotaRedirectKey = (subject: string) =>
  `free_quota_gmail_migration:v1:redirect:${subject}`;

// Recheck in the same transaction as admission. A request can resolve its
// subject just before the operator pauses, then reach Redis after the pause.
export const FREE_QUOTA_ADMISSION_GUARD_SCRIPT = `
local migrationState = redis.call("GET", "${FREE_QUOTA_MIGRATION_STATE}")
if migrationState == "paused" or migrationState == "migrated" then
  return redis.error_reply("Free quota migration paused")
end
`;

// Resolve again inside each Redis transaction. A caller may hold an old subject
// across cutover; settlement must land either before the transfer or after it,
// never recreate a discarded source counter.
export const FREE_QUOTA_KEY_REDIRECT_SCRIPT = `
for i, key in ipairs(KEYS) do
  local subject = string.match(key, "free_quota:v1:%x+")
  if subject then
    local target = redis.call("GET", "free_quota_gmail_migration:v1:redirect:" .. subject)
    if target then KEYS[i] = string.gsub(key, subject, target) end
  end
end
`;

/** Old durable payloads and rollback builds must continue charging merged keys. */
export async function resolveMigratedFreeQuotaSubject(
  redis: Redis,
  subject: string,
  settlement = false,
): Promise<string> {
  const state = await redis.get<string>(FREE_QUOTA_MIGRATION_STATE);
  if (
    !settlement &&
    (state === "paused" ||
      state === "migrated" ||
      (process.env.FREE_QUOTA_GMAIL_CANONICALIZATION === "true" &&
        state !== "complete"))
  ) {
    throw new ChatSDKError(
      "rate_limit:chat",
      "Free usage is temporarily unavailable. Please try again shortly.",
    );
  }
  if (!subject.startsWith("free_quota:v1:")) return subject;
  return (await redis.get<string>(freeQuotaRedirectKey(subject))) ?? subject;
}

// One alias's counters and forwarding pointer move in a single transaction.
// All callers must be drained before migration: see the cutover runbook.
// Source keys disappear, so retries cannot charge the same usage twice.
export const MIGRATE_FREE_QUOTA_ALIAS_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= "paused" then
  return redis.error_reply("Free traffic must be paused")
end
local prior = redis.call("GET", KEYS[2])
if prior and prior ~= ARGV[1] then
  return redis.error_reply("Conflicting quota redirect")
end
-- Validate the entire alias before writing (Redis scripts do not roll back).
for i = 3, #KEYS, 2 do
  local source = redis.call("GET", KEYS[i])
  local target = redis.call("GET", KEYS[i+1])
  if (source and not tonumber(source)) or (target and not tonumber(target)) then
    return redis.error_reply("Non-numeric quota state")
  end
  if tonumber(source or "0") + tonumber(target or "0") > 9007199254740991 then
    return redis.error_reply("Quota counter exceeds safe integer range")
  end
  if source and (tonumber(source) < 0 or tonumber(source) % 1 ~= 0) then
    return redis.error_reply("Invalid quota counter")
  end
  if target and (tonumber(target) < 0 or tonumber(target) % 1 ~= 0) then
    return redis.error_reply("Invalid quota counter")
  end
end
for i = 3, #KEYS, 2 do
  local source = redis.call("GET", KEYS[i])
  if source then
    local target = redis.call("GET", KEYS[i+1])
    local sourceTTL = redis.call("PTTL", KEYS[i])
    local targetTTL = redis.call("PTTL", KEYS[i+1])
    local value = tonumber(source) + tonumber(target or "0")
    if ARGV[(i-3)/2+2] == "marker" then value = 1 end
    redis.call("SET", KEYS[i+1], value)
    if sourceTTL >= 0 and targetTTL ~= -1 then
      redis.call("PEXPIRE", KEYS[i+1], math.max(1, sourceTTL, targetTTL))
    end
    redis.call("DEL", KEYS[i])
  end
end
redis.call("SET", KEYS[2], ARGV[1])
return 1
`;
