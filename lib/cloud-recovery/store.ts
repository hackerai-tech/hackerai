import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export const RECOVERY_FLAG = "cloud-workspace-customer-recovery";
export const failureKey = (userId: string) =>
  `cloud_resume_failures:v1:${userId}`;
export const consentKey = (userId: string) =>
  `cloud_recovery_consent:v1:${userId}`;
export const failureSchema = z.object({
  sandboxId: z.string().min(1),
  region: z.enum(["us-east-1", "us-west-2", "eu-central-1"]),
  template: z.string().min(1),
  sandboxVersion: z.string().min(1),
  attempts: z.array(z.string().uuid()).min(1).max(2),
  uncertain: z.boolean(),
  lastFailedAt: z.number(),
});
export type ResumeFailures = z.infer<typeof failureSchema>;
export const consentSchema = z.object({
  token: z.string().uuid(),
  target: failureSchema,
  status: z.enum(["offered", "declined", "confirmed", "executing", "failed"]),
  issuedAt: z.number(),
  confirmedAt: z.number().optional(),
});
export type RecoveryConsent = z.infer<typeof consentSchema>;
export function recoveryRedis() {
  const redis = createRedisClient();
  if (!redis) throw new Error("Recovery store unavailable");
  return redis;
}
export async function readFailures(userId: string) {
  const raw = await recoveryRedis().get(failureKey(userId));
  return raw === null ? null : failureSchema.parse(raw);
}
export async function readConsent(userId: string) {
  const raw = await recoveryRedis().get(consentKey(userId));
  return raw === null ? null : consentSchema.parse(raw);
}

/** SDK retries share one acquisition id. They cannot manufacture eligibility. */
export async function recordResumeFailure(args: {
  userId: string;
  sandboxId: string;
  region: TriggerRunRegion;
  template: string;
  sandboxVersion: string;
  acquisitionId: string;
  uncertain: boolean;
}) {
  // No new runtime writes until the environment has an explicit recovery target.
  if (!process.env.CLOUD_DISK_RECOVERY_TARGETS) return;
  if (
    (await getPostHogBooleanFlagDecisionForUser(
      RECOVERY_FLAG,
      args.userId,
      undefined,
      { sendFeatureFlagEvents: false },
    )) !== true
  )
    return;
  const next = failureSchema.parse({
    ...args,
    attempts: [args.acquisitionId],
    lastFailedAt: Date.now(),
  });
  await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); local next = cjson.decode(ARGV[1]);
     if raw then
       local prior = cjson.decode(raw)
       if prior.sandboxId == next.sandboxId and prior.region == next.region and prior.template == next.template and prior.sandboxVersion == next.sandboxVersion then
         next.attempts = prior.attempts; next.uncertain = prior.uncertain or next.uncertain
         for _, id in ipairs(next.attempts) do if id == ARGV[2] then return 0 end end
         if #next.attempts < 2 then table.insert(next.attempts, ARGV[2]) end
       end
     end
     redis.call('SET', KEYS[1], cjson.encode(next), 'EX', 86400); return 1`,
    [failureKey(args.userId)],
    [JSON.stringify(next), args.acquisitionId],
  );
}
export async function clearResumeFailures(userId: string, sandboxId: string) {
  if (!process.env.CLOUD_DISK_RECOVERY_TARGETS) return;
  await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if raw and cjson.decode(raw).sandboxId == ARGV[1] then redis.call('DEL', KEYS[1]) end return 1`,
    [failureKey(userId)],
    [sandboxId],
  );
}
export async function offerConsent(userId: string, target: ResumeFailures) {
  const record: RecoveryConsent = {
    token: randomUUID(),
    target,
    status: "offered",
    issuedAt: Date.now(),
  };
  await recoveryRedis().set(consentKey(userId), record, { nx: true });
  // A permanent record prevents prompting or rebooting again after a refresh.
  return (await readConsent(userId))!;
}
export async function decideConsent(
  userId: string,
  consent: RecoveryConsent,
  confirmed: boolean,
) {
  const next = {
    ...consent,
    status: confirmed ? "confirmed" : "declined",
    ...(confirmed && { confirmedAt: Date.now() }),
  };
  const changed = await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw)
     if current.token ~= ARGV[1] or current.status ~= 'offered' or current.issuedAt ~= tonumber(ARGV[3]) then return 0 end
     redis.call('SET', KEYS[1], ARGV[2]); return 1`,
    [consentKey(userId)],
    [consent.token, JSON.stringify(next), String(consent.issuedAt)],
  );
  return changed === 1;
}

export async function failConsent(userId: string, token: string) {
  await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw); if current.token ~= ARGV[1] or (current.status ~= 'confirmed' and current.status ~= 'executing') then return 0 end
     current.status = 'failed'; redis.call('SET', KEYS[1], cjson.encode(current)); return 1`,
    [consentKey(userId)],
    [token],
  );
}
