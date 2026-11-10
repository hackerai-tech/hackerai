// Operator-only retirement after the provider owner confirms Miosa is gone.
// The caller must verify environment identity and fetch sandboxInfo from E2B.
// This never creates, deletes, resumes, or writes files in any sandbox.
export function prepareMiosaRetirement({
  userId,
  expectedRaw,
  sandboxInfo,
  region,
  retirementId,
  providerRetirementAuthorized,
  expectedFailuresRaw = null,
}) {
  if (providerRetirementAuthorized !== true)
    throw Error("Retirement not authorized");
  if (
    !/^user_[A-Za-z0-9]+$/.test(userId) ||
    !/^[a-f0-9-]{36}$/.test(retirementId)
  )
    throw Error("Invalid retirement identity");
  const state = JSON.parse(expectedRaw);
  const legacy = state.phase === "e2b" ? state.recoveryPending : state;
  if (
    state.version !== 1 ||
    !["cleanup", "e2b"].includes(state.phase) ||
    typeof state.token !== "string" ||
    !state.token ||
    legacy?.version !== 1 ||
    legacy.phase !== "cleanup" ||
    !["miosa-to-e2b", "miosa-to-e2b-duplicates"].includes(
      legacy.recovery?.operation,
    )
  )
    throw Error("Not a retired Miosa fence");
  if (
    !["us-east-1", "us-west-2", "eu-central-1"].includes(region) ||
    typeof sandboxInfo?.sandboxId !== "string" ||
    !sandboxInfo.sandboxId ||
    sandboxInfo.metadata?.userID !== userId ||
    !["paused", "running"].includes(sandboxInfo.state) ||
    sandboxInfo.lifecycle?.onTimeout !== "pause"
  )
    throw Error("Unverified E2B destination");
  let replacement;
  if (state.phase === "e2b") {
    if (
      state.destinationId !== sandboxInfo.sandboxId ||
      state.region !== region ||
      typeof state.sourceId !== "string" ||
      !state.sourceId
    )
      throw Error("Existing E2B destination must be preserved");
    const { recoveryPending: _retired, ...current } = state;
    replacement = current;
  } else {
    if (
      sandboxInfo.metadata?.miosaRetirementId !== retirementId ||
      sandboxInfo.sandboxId === legacy.recovery.e2bId ||
      legacy.recovery.e2bIds?.includes(sandboxInfo.sandboxId)
    )
      throw Error("Fresh E2B destination required");
    if (expectedFailuresRaw !== null)
      throw Error("Existing recovery failure requires reconciliation");
    replacement = {
      version: 1,
      phase: "e2b",
      token: retirementId,
      sourceId: sandboxInfo.sandboxId,
      destinationId: sandboxInfo.sandboxId,
      region,
    };
  }
  return {
    keys: [
      `cloud_workspace_migration:v1:${userId}`,
      `cloud_workspace_activity:v1:${userId}`,
      `cloud_recovery_consent:v1:${userId}`,
      `cloud_workspace_recovery_result:v1:${userId}`,
      `cloud_workspace_region:v1:${userId}`,
      `cloud_miosa_retirement_archive:v1:${userId}:${retirementId}`,
      `cloud_resume_failures:v1:${userId}`,
    ],
    args: [
      expectedRaw,
      JSON.stringify(replacement),
      region,
      expectedFailuresRaw ?? "",
    ],
    replacement,
  };
}

// Archive and routing transition are atomic. Never clear active recovery,
// deletion, or a concurrently changed record; keep failure receipts intact.
export const RETIRE_MIOSA_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'state_changed' end
if redis.call('EXISTS', KEYS[2], KEYS[3], KEYS[4]) ~= 0 then return 'busy' end
if (redis.call('GET', KEYS[7]) or '') ~= ARGV[4] then return 'recovery_changed' end
local binding = redis.call('GET', KEYS[5])
if binding and binding ~= ARGV[3] then
  local ok, decoded = pcall(cjson.decode, binding)
  if not ok or decoded ~= ARGV[3] then return 'region_conflict' end
end
if redis.call('EXISTS', KEYS[6]) ~= 0 then return 'archive_exists' end
redis.call('SET', KEYS[6], ARGV[1])
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[5], ARGV[3])
return 'retired'
`;
