import { z } from "zod";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";
import {
  activityKeyFor,
  cloudRecoveryHistoryKey,
  cloudWorkspaceRegionKey,
  cloudWorkspaceStateKey,
  recoveryResultKeyFor,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import {
  consentKey,
  consentSchema,
  failureKey,
  failureSchema,
  recoveryRedis,
} from "./store";

const region = z.enum(["us-east-1", "us-west-2", "eu-central-1"]);
const bindingSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("e2b"),
    token: z.string().min(1),
    sourceId: z.string().min(1),
    destinationId: z.string().min(1),
    region,
    origin: z.enum(["adopted", "created", "selected"]).optional(),
  })
  .strict();
const resultSchema = z
  .object({
    token: z.string().uuid(),
    status: z.literal("verified_ready"),
    sandboxId: z.string().min(1),
    region,
    completedAt: z.iso.datetime(),
    backupSnapshotId: z.string().min(1),
  })
  .passthrough();

/** Retire only a proven completed incident. No provider calls or new authorization. */
export async function reconcileCompletedRecovery(
  userId: string,
): Promise<boolean> {
  const redis = recoveryRedis();
  const keys = [
    cloudWorkspaceStateKey(userId),
    consentKey(userId),
    recoveryResultKeyFor(userId),
    failureKey(userId),
    cloudWorkspaceRegionKey(userId),
    activityKeyFor(userId),
    cloudRecoveryHistoryKey(userId),
  ];
  const values = await redis.mget<unknown[]>(...keys.slice(0, 6));
  const [workspaceRaw, consentRaw, resultRaw, failuresRaw, saved, activity] =
    values;
  if (activity !== null || consentRaw === null || resultRaw === null)
    return false;
  const workspace = bindingSchema.safeParse(workspaceRaw);
  const consent = consentSchema.safeParse(consentRaw);
  const result = resultSchema.safeParse(resultRaw);
  const failures =
    failuresRaw === null ? null : failureSchema.safeParse(failuresRaw);
  if (
    !workspace.success ||
    !consent.success ||
    !result.success ||
    (failures && !failures.success)
  )
    return false;
  const w = workspace.data,
    c = consent.data,
    r = result.data;
  if (
    !["executing", "failed"].includes(c.status) ||
    r.token !== c.token ||
    r.sandboxId !== c.target.sandboxId ||
    r.region !== c.target.region ||
    w.destinationId !== r.sandboxId ||
    w.region !== r.region ||
    (saved !== null && saved !== w.region) ||
    Date.parse(r.completedAt) < (c.confirmedAt ?? c.issuedAt) ||
    Date.parse(r.completedAt) > Date.now() ||
    (failures?.success &&
      (failures.data.sandboxId !== r.sandboxId ||
        failures.data.region !== r.region))
  )
    return false;
  const [parents, children] = await Promise.all([
    getActiveTriggerRunsForUser({ userId }),
    listActiveSubagentsForUser(userId),
  ]);
  if (
    parents.hasMore ||
    children.hasMore ||
    parents.runs.length ||
    children.runs.length
  )
    return false;
  // A new incident survives reconciliation. Only stale evidence covered by the
  // completed verification is removed; no failure timestamps are manufactured.
  const clearFailures =
    failures?.success &&
    failures.data.lastFailedAt <= Date.parse(r.completedAt);
  const changed = await redis.eval(
    `local function equal(a,b)
       if type(a) ~= type(b) then return false end
       if type(a) ~= 'table' then return a == b end
       for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
       for k in pairs(b) do if a[k] == nil then return false end end
       return true
     end
     if redis.call('EXISTS',KEYS[6]) == 1 then return 0 end
     for i=1,4 do
       local raw = redis.call('GET',KEYS[i])
       if ARGV[i] == '' then if raw then return 0 end
       else
         local ok,current = pcall(cjson.decode,raw or '')
         local expectedOk,expected = pcall(cjson.decode,ARGV[i])
         if not ok or not expectedOk or not equal(current,expected) then return 0 end
       end
     end
     if (redis.call('GET',KEYS[5]) or '') ~= ARGV[5] then return 0 end
     if redis.call('HSETNX',KEYS[7],ARGV[6],ARGV[7]) ~= 1 then return 0 end
     redis.call('DEL',KEYS[2],KEYS[3])
     if ARGV[8] == '1' then redis.call('DEL',KEYS[4]) end
     return 1`,
    keys,
    [
      ...values
        .slice(0, 4)
        .map((value) => (value === null ? "" : JSON.stringify(value))),
      saved ?? "",
      c.token,
      JSON.stringify({
        consent: consentRaw,
        result: resultRaw,
        workspace: workspaceRaw,
        failures: failuresRaw,
        archivedAt: new Date().toISOString(),
      }),
      clearFailures ? "1" : "0",
    ],
  );
  return changed === 1;
}
