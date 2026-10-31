import {
  activityKeyFor,
  cloudRecoveryConsentKey,
  cloudWorkspaceStateKey,
  recoveryResultKeyFor,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export const RECOVERY_FLAG = "cloud-workspace-customer-recovery";
export const failureKey = (userId: string) =>
  `cloud_resume_failures:v1:${userId}`;
export const consentKey = cloudRecoveryConsentKey;
export const failureSchema = z.object({
  sandboxId: z.string().min(1),
  region: z.enum(["us-east-1", "us-west-2", "eu-central-1"]),
  template: z.string().min(1),
  sandboxVersion: z.string().min(1),
  attempts: z.array(z.string().uuid()).min(1).max(2),
  uncertain: z.boolean(),
  timeoutOnly: z.boolean().optional(),
  lastFailedAt: z.number(),
});
export type ResumeFailures = z.infer<typeof failureSchema>;
export const consentSchema = z.object({
  token: z.string().uuid(),
  target: failureSchema,
  status: z.enum(["offered", "declined", "confirmed", "executing", "failed"]),
  issuedAt: z.number(),
  confirmedAt: z.number().optional(),
  organizationId: z.string().min(1).optional(),
  // Missing on historical receipts: never infer retry permission from absence.
  failurePhase: z.enum(["before_reboot", "reboot_or_unknown"]).optional(),
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
  timeoutOnly?: boolean;
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
         next.attempts = prior.attempts
         next.timeoutOnly = (not prior.uncertain or prior.timeoutOnly == true) and (not next.uncertain or next.timeoutOnly == true)
         next.uncertain = prior.uncertain or next.uncertain
         for _, id in ipairs(next.attempts) do
           if id == ARGV[2] then
             if next.uncertain ~= prior.uncertain or (next.uncertain and next.timeoutOnly ~= prior.timeoutOnly) then
               redis.call('SET', KEYS[1], cjson.encode(next), 'EX', 86400)
             end
             return 0
           end
         end
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
  // Used receipts remain durable. A verified preflight failure needs a fresh token.
  return (await readConsent(userId))!;
}
export async function decideConsent(
  userId: string,
  consent: RecoveryConsent,
  confirmed: boolean,
  organizationId?: string,
) {
  const next = {
    ...consent,
    status: confirmed ? "confirmed" : "declined",
    ...(confirmed && { confirmedAt: Date.now(), organizationId }),
  };
  const changed = await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw)
     if current.token ~= ARGV[1] or current.status ~= 'offered' or current.issuedAt ~= tonumber(ARGV[3]) then return 0 end
     if ARGV[4] == '1' then
       if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
       local workspaceRaw = redis.call('GET', KEYS[3])
       if workspaceRaw then
         local ok, workspace = pcall(cjson.decode, workspaceRaw)
         if not ok or type(workspace) ~= 'table' or workspace.phase ~= 'e2b' then return 0 end
       end
     end
     redis.call('SET', KEYS[1], ARGV[2]); return 1`,
    [
      consentKey(userId),
      activityKeyFor(userId),
      cloudWorkspaceStateKey(userId),
    ],
    [
      consent.token,
      JSON.stringify(next),
      String(consent.issuedAt),
      confirmed ? "1" : "0",
    ],
  );
  return changed === 1;
}

export async function failConsent(userId: string, token: string) {
  await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw); if current.token ~= ARGV[1] or (current.status ~= 'confirmed' and current.status ~= 'executing') then return 0 end
     -- Claiming the durable fence atomically changes confirmed to executing.
     -- A delayed worker cannot claim this token after it has been failed.
     local safe = true
     local workspaceRaw = redis.call('GET', KEYS[2])
     if workspaceRaw then
       local ok, workspace = pcall(cjson.decode, workspaceRaw)
       safe = ok and type(workspace) == 'table' and workspace.version == 1 and workspace.phase == 'e2b' and workspace.destinationId == current.target.sandboxId and workspace.region == current.target.region
       local allowed = {version=true, phase=true, token=true, sourceId=true, destinationId=true, region=true}
       if safe then for field in pairs(workspace) do if not allowed[field] then safe = false end end end
     end
     local resultRaw = redis.call('GET', KEYS[3])
     if resultRaw then
       local ok, result = pcall(cjson.decode, resultRaw)
       safe = safe and ok and type(result) == 'table' and type(result.token) == 'string' and result.token ~= current.token and (result.status == 'verified_ready' or result.status == 'verified_paused') and result.sandboxId == current.target.sandboxId and result.region == current.target.region
     end
     current.failurePhase = 'reboot_or_unknown'
     if current.status == 'confirmed' and safe then
       current.failurePhase = 'before_reboot'
     end
     current.status = 'failed'; redis.call('SET', KEYS[1], cjson.encode(current)); return 1`,
    [
      consentKey(userId),
      cloudWorkspaceStateKey(userId),
      recoveryResultKeyFor(userId),
    ],
    [token],
  );
}

/** Only call after fresh eligibility checks; this never dispatches provider work. */
export async function retryPreflightConsent(
  userId: string,
  consent: RecoveryConsent,
  target: ResumeFailures,
) {
  const next: RecoveryConsent = {
    token: randomUUID(),
    target,
    status: "offered",
    issuedAt: Date.now(),
  };
  const changed = await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw)
     local next = cjson.decode(ARGV[2])
     if current.token ~= ARGV[1] or current.status ~= 'failed' or current.failurePhase ~= 'before_reboot' then return 0 end
     for _, field in ipairs({'sandboxId', 'region', 'template', 'sandboxVersion'}) do
       if current.target[field] ~= next.target[field] then return 0 end
     end
     local safe = true
     local workspaceRaw = redis.call('GET', KEYS[2])
     if workspaceRaw then
       local ok, workspace = pcall(cjson.decode, workspaceRaw)
       safe = ok and type(workspace) == 'table' and workspace.version == 1 and workspace.phase == 'e2b' and workspace.destinationId == current.target.sandboxId and workspace.region == current.target.region
       local allowed = {version=true, phase=true, token=true, sourceId=true, destinationId=true, region=true}
       if safe then for field in pairs(workspace) do if not allowed[field] then safe = false end end end
     end
     local resultRaw = redis.call('GET', KEYS[3])
     if resultRaw then
       local ok, result = pcall(cjson.decode, resultRaw)
       safe = safe and ok and type(result) == 'table' and type(result.token) == 'string' and result.token ~= current.token and (result.status == 'verified_ready' or result.status == 'verified_paused') and result.sandboxId == current.target.sandboxId and result.region == current.target.region
     end
     if not safe or redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
     -- Retain the consumed receipt for diagnosis, never renew its authorization.
     if redis.call('SET', KEYS[5], raw, 'NX') == false then return 0 end
     redis.call('SET', KEYS[1], ARGV[2]); return 1`,
    [
      consentKey(userId),
      cloudWorkspaceStateKey(userId),
      recoveryResultKeyFor(userId),
      activityKeyFor(userId),
      `cloud_recovery_attempt:v1:${userId}:${consent.token}`,
    ],
    [consent.token, JSON.stringify(next)],
  );
  return changed === 1 ? next : null;
}

/**
 * Operator-only reconciliation for historical receipts without phase evidence.
 * Call only after independently verifying the original task is terminal and the
 * provider confirms no reboot occurred. Never expose this to customer requests.
 * expectedRaw must be the exact stored receipt, not a reconstructed object.
 */
export async function reconcileLegacyPreflightFailure(
  userId: string,
  expectedRaw: string,
  evidence: {
    taskTerminal: boolean;
    providerConfirmedNoReboot: boolean;
    reference: string;
  },
) {
  const receipt = consentSchema.parse(JSON.parse(expectedRaw));
  if (
    receipt.status !== "failed" ||
    receipt.failurePhase !== undefined ||
    !evidence.taskTerminal ||
    !evidence.providerConfirmedNoReboot ||
    !evidence.reference.trim()
  )
    throw new Error("Legacy recovery requires independent pre-reboot evidence");
  const changed = await recoveryRedis().eval(
    `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     for i=2,4 do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
     local current = cjson.decode(ARGV[1])
     if current.status ~= 'failed' or current.failurePhase ~= nil then return 0 end
     if redis.call('SET', KEYS[5], ARGV[2], 'NX') == false then return 0 end
     current.failurePhase = 'before_reboot'
     redis.call('SET', KEYS[1], cjson.encode(current)); return 1`,
    [
      consentKey(userId),
      cloudWorkspaceStateKey(userId),
      recoveryResultKeyFor(userId),
      activityKeyFor(userId),
      `cloud_recovery_reconciliation:v1:${userId}:${receipt.token}`,
    ],
    [
      expectedRaw,
      JSON.stringify({
        receipt: JSON.parse(expectedRaw),
        evidence,
        reviewedAt: Date.now(),
      }),
    ],
  );
  return changed === 1;
}

/** Reopening or refreshing an unconsumed offer cannot reset an attempted recovery. */
export async function renewConsent(
  userId: string,
  consent: RecoveryConsent,
  target: ResumeFailures = consent.target,
) {
  const next: RecoveryConsent = {
    ...consent,
    target,
    token: randomUUID(),
    status: "offered",
    issuedAt: Date.now(),
  };
  const changed = await recoveryRedis().eval(
    `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
     local current = cjson.decode(raw)
     if current.token ~= ARGV[1] or (current.status ~= 'offered' and current.status ~= 'declined') then return 0 end
     redis.call('SET', KEYS[1], ARGV[2]); return 1`,
    [consentKey(userId)],
    [consent.token, JSON.stringify(next)],
  );
  return changed === 1 ? next : null;
}
