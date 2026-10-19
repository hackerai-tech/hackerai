import { createHmac } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { z } from "zod";
import {
  getActiveTriggerRunsForUser,
  getCurrentAgentEntitlementContext,
} from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  readCloudWorkspaceState,
  readE2BDiskRecoveryResult,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import {
  recoverE2BDiskOnly,
  validateDiskRecoveryAuthorization,
  type DiskRecoveryAuthorization,
} from "@/lib/ai/tools/utils/e2b-disk-recovery";
import {
  consentKey,
  readConsent,
  readFailures,
  recoveryRedis,
  offerConsent,
  decideConsent,
  failConsent,
  type RecoveryConsent,
  type ResumeFailures,
} from "./store";

export const RECOVERY_FLAG = "cloud-workspace-customer-recovery";
const manifestSchema = z
  .object({
    environment: z.enum(["preview", "production"]),
    e2bAccount: z.string().min(1),
    e2bProject: z.string().min(1),
    expectedApiKeyHmacSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRedisHost: z.string().min(1),
    expectedConvexUrl: z.url(),
    // Pin regional endpoint and PostHog project selection independently on web and worker.
    expectedDomain: z.string().min(1),
    expectedPostHogKeyHmacSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RecoveryView = {
  status:
    | "hidden"
    | "waiting"
    | "support"
    | "offered"
    | "declined"
    | "recovering"
    | "recovered";
  token?: string;
  step?: string;
};
export class RecoveryUnavailable extends Error {}
class RecoveryBusy extends RecoveryUnavailable {}
function targetAuthorization(userId: string, consent: RecoveryConsent) {
  const all = z
    .partialRecord(
      z.enum(["us-east-1", "us-west-2", "eu-central-1"]),
      manifestSchema,
    )
    .parse(JSON.parse(process.env.CLOUD_DISK_RECOVERY_TARGETS ?? "{}"));
  const config = all[consent.target.region];
  if (!config) throw new RecoveryUnavailable();
  const cluster = getE2BClusterRouting(consent.target.region).createCluster;
  const key =
    consent.target.region === "eu-central-1"
      ? process.env.E2B_EU_API_KEY
      : process.env.E2B_API_KEY;
  if (
    !key ||
    process.env.E2B_API_URL ||
    process.env.E2B_SANDBOX_URL ||
    process.env.E2B_DEBUG?.toLowerCase() === "true" ||
    (process.env.E2B_DOMAIN &&
      process.env.E2B_DOMAIN !== config.expectedDomain) ||
    (cluster.connectionOptions?.domain ?? "e2b.app") !==
      config.expectedDomain ||
    !process.env.NEXT_PUBLIC_POSTHOG_KEY ||
    createHmac("sha256", key)
      .update(process.env.NEXT_PUBLIC_POSTHOG_KEY)
      .digest("hex") !== config.expectedPostHogKeyHmacSha256 ||
    consent.target.template !== cluster.template ||
    consent.target.sandboxVersion !== "v12"
  )
    throw new RecoveryUnavailable();
  return validateDiskRecoveryAuthorization({
    ...config,
    version: 1,
    userId,
    sandboxId: consent.target.sandboxId,
    region: consent.target.region,
    expectedTemplate: consent.target.template,
    expectedSandboxVersion: consent.target.sandboxVersion,
    operatorId: `customer:${userId}`,
    idempotencyKey: consent.token,
    intent: "I accept loss of running processes and unflushed writes",
    trafficQuiesced: true,
  });
}
async function enabled(userId: string) {
  if (!process.env.CLOUD_DISK_RECOVERY_TARGETS) return false;
  return (
    (await getPostHogBooleanFlagDecisionForUser(
      RECOVERY_FLAG,
      userId,
      undefined,
      { sendFeatureFlagEvents: false },
    )) === true
  );
}
export async function assertNoActiveWork(userId: string) {
  const [parents, children] = await Promise.all([
    getActiveTriggerRunsForUser({ userId }),
    listActiveSubagentsForUser(userId),
  ]);
  if (
    parents.hasMore ||
    parents.runs.length ||
    children.hasMore ||
    children.runs.length
  )
    throw new RecoveryBusy();
}
function sameTarget(a: ResumeFailures, b: ResumeFailures) {
  return (
    a.sandboxId === b.sandboxId &&
    a.region === b.region &&
    a.template === b.template &&
    a.sandboxVersion === b.sandboxVersion
  );
}
async function assertEligible(
  userId: string,
  consent: RecoveryConsent,
): Promise<DiskRecoveryAuthorization> {
  const auth = targetAuthorization(userId, consent);
  const failures = await readFailures(userId);
  if (
    !failures ||
    !sameTarget(failures, consent.target) ||
    failures.attempts.length < 2 ||
    failures.uncertain ||
    Date.now() - failures.lastFailedAt > 86400000
  )
    throw new RecoveryUnavailable();
  const workspace = await readCloudWorkspaceState(userId);
  if (
    workspace &&
    (workspace.phase !== "e2b" ||
      workspace.destinationId !== auth.sandboxId ||
      workspace.region !== auth.region ||
      workspace.recoveryPending !== undefined ||
      Object.keys(workspace).some(
        (key) =>
          ![
            "version",
            "phase",
            "token",
            "sourceId",
            "destinationId",
            "region",
          ].includes(key),
      ))
  )
    throw new RecoveryUnavailable();
  if (await recoveryRedis().exists(`cloud_workspace_activity:v1:${userId}`))
    throw new RecoveryBusy();
  await assertNoActiveWork(userId);
  const cluster = getE2BClusterRouting(auth.region).createCluster;
  const info = await Sandbox.getInfo(auth.sandboxId, {
    ...cluster.connectionOptions,
    requestTimeoutMs: 10000,
  });
  if (
    info.sandboxId !== auth.sandboxId ||
    info.state !== "paused" ||
    info.metadata?.userID !== userId ||
    info.metadata?.e2bCluster !== cluster.cluster ||
    info.metadata?.template !== auth.expectedTemplate ||
    info.metadata?.sandboxVersion !== auth.expectedSandboxVersion ||
    info.lifecycle?.autoResume !== false ||
    info.lifecycle?.onTimeout !== "pause" ||
    Object.keys(info.metadata ?? {}).some(
      (key) =>
        ![
          "userID",
          "e2bCluster",
          "template",
          "sandboxVersion",
          "secure",
        ].includes(key),
    )
  )
    throw new RecoveryUnavailable();
  // Inventory is read-only: an extra regional workspace is an ownership ambiguity.
  const list = Sandbox.list({
    ...cluster.connectionOptions,
    requestTimeoutMs: 10000,
    query: { metadata: { userID: userId }, state: ["running", "paused"] },
  });
  const items = await list.nextItems();
  if (
    list.hasNext ||
    items.length !== 1 ||
    items[0].sandboxId !== auth.sandboxId
  )
    throw new RecoveryUnavailable();
  return auth;
}
export async function recoveryView(userId: string): Promise<RecoveryView> {
  if (!(await enabled(userId))) return { status: "hidden" };
  const consent = await readConsent(userId);
  if (consent) {
    const workspace = await readCloudWorkspaceState(userId);
    const result = (await readE2BDiskRecoveryResult(userId)) as {
      token?: string;
      status?: string;
      sandboxId?: string;
      region?: string;
    } | null;
    if (
      result?.token === consent.token &&
      result.status === "verified_paused" &&
      result.sandboxId === consent.target.sandboxId &&
      result.region === consent.target.region &&
      workspace?.phase === "e2b" &&
      workspace.destinationId === consent.target.sandboxId &&
      workspace.region === consent.target.region &&
      workspace.recoveryPending === undefined
    )
      return { status: "recovered" };
    if (consent.status === "failed") return { status: "support" };
    if (
      workspace?.phase === "recovery" ||
      ["confirmed", "executing"].includes(consent.status)
    ) {
      const started =
        workspace?.phase === "recovery"
          ? Date.parse(workspace.startedAt)
          : consent.issuedAt;
      // Interrupted/expired work remains fenced and is never retried by the UI.
      return {
        status:
          (workspace?.phase === "recovery" &&
            workspace.step === "support_required") ||
          Date.now() - started > 25 * 60000
            ? "support"
            : "recovering",
        step: workspace?.phase === "recovery" ? workspace.step : "queued",
      };
    }
    if (consent.status === "declined") return { status: "declined" };
    if (!(await readFailures(userId))) return { status: "hidden" };
    if (Date.now() - consent.issuedAt > 10 * 60000)
      return { status: "support" };
    try {
      await assertEligible(userId, consent);
      return { status: "offered", token: consent.token };
    } catch (error) {
      return { status: error instanceof RecoveryBusy ? "waiting" : "support" };
    }
  }
  const failures = await readFailures(userId);
  if (!failures || failures.attempts.length < 2) return { status: "hidden" };
  if (failures.uncertain) return { status: "support" };
  const candidate: RecoveryConsent = {
    token: crypto.randomUUID(),
    target: failures,
    status: "offered",
    issuedAt: Date.now(),
  };
  try {
    await assertEligible(userId, candidate);
  } catch (error) {
    return { status: error instanceof RecoveryBusy ? "waiting" : "support" };
  }
  const offered = await offerConsent(userId, failures);
  return offered.status === "offered"
    ? { status: "offered", token: offered.token }
    : { status: "support" };
}
export async function confirmRecovery(
  userId: string,
  token: string,
  confirmed: boolean,
) {
  if (!(await enabled(userId))) throw new RecoveryUnavailable();
  const consent = await readConsent(userId);
  if (!consent || consent.token !== token) throw new RecoveryUnavailable();
  if (consent.status !== "offered") return null;
  if (Date.now() - consent.issuedAt > 10 * 60000)
    throw new RecoveryUnavailable();
  if (confirmed) await assertEligible(userId, consent);
  if (!(await decideConsent(userId, consent, confirmed))) return null;
  return confirmed ? consent : null;
}
export async function executeCustomerRecovery(
  userId: string,
  token: string,
  region: ResumeFailures["region"],
) {
  if (!(await enabled(userId))) throw new RecoveryUnavailable();
  const consent = await readConsent(userId);
  if (
    !consent ||
    consent.token !== token ||
    consent.status !== "confirmed" ||
    consent.target.region !== region
  )
    throw new RecoveryUnavailable();
  try {
    // A delayed dispatch is not permission to reboot hours after confirmation.
    if (Date.now() - consent.issuedAt > 10 * 60000)
      throw new RecoveryUnavailable();
    const auth = await assertEligible(userId, consent);
    const entitlement = await getCurrentAgentEntitlementContext({ userId });
    if (entitlement.subscription === "free") throw new RecoveryUnavailable();
    await assertUserCanMakeCostIncurringRequest(userId);
    await recoverE2BDiskOnly(auth, {
      consentKey: consentKey(userId),
      assertIdle: () => assertNoActiveWork(userId),
    });
    phLogger.event("cloud_workspace_customer_recovery_completed", {
      userId,
      outcome: "verified",
    });
  } catch {
    await failConsent(userId, token).catch(() => {});
    phLogger.event("cloud_workspace_customer_recovery_completed", {
      userId,
      outcome: "support_required",
    });
    // No provider error messages, snapshots, workspace ids or authorization in task output.
    throw new RecoveryUnavailable("Recovery requires support reconciliation");
  }
  return { status: "verified" };
}
