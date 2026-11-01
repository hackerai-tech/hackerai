import { isRecoverableE2BSandboxVersion } from "@/lib/ai/tools/utils/e2b-sandbox-version";
import { createHmac } from "node:crypto";
import {
  Sandbox,
  SandboxError,
  RateLimitError,
  ServiceBusyError,
} from "@e2b/code-interpreter";
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
  activityKeyFor,
  readE2BDiskRecoveryResult,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import {
  recoverE2BDiskOnly,
  DiskRecoveryError,
  validateDiskRecoveryAuthorization,
  type DiskRecoveryAuthorization,
} from "@/lib/ai/tools/utils/e2b-disk-recovery";
import {
  RECOVERY_FLAG,
  consentKey,
  readConsent,
  readFailures,
  recoveryRedis,
  offerConsent,
  decideConsent,
  failConsent,
  renewConsent,
  retryPreflightConsent,
  type RecoveryConsent,
  type ResumeFailures,
} from "./store";

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
  reference?: string;
};
export class RecoveryUnavailable extends Error {}
class RecoveryBusy extends RecoveryUnavailable {}
function eligibilityFailureStatus(error: unknown): "waiting" | "support" {
  // Only retry status reads. Consent and recovery mutations still fail closed.
  // The SDK's REST request deadline rejects with a DOM TimeoutError.
  const temporaryReadFailure =
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof TypeError && error.message === "fetch failed") ||
    error instanceof RateLimitError ||
    error instanceof ServiceBusyError ||
    (error instanceof SandboxError &&
      [500, 502, 504, 529].includes(error.statusCode ?? 0));
  return error instanceof RecoveryBusy || temporaryReadFailure
    ? "waiting"
    : "support";
}
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
    !isRecoverableE2BSandboxVersion(consent.target.sandboxVersion)
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
type RecoveryStage =
  | "dispatch"
  | "consent_age"
  | "manifest"
  | "failure_evidence"
  | "idle_window"
  | "workspace_state"
  | "activity"
  | "active_runs"
  | "provider_identity"
  | "provider_inventory"
  | "entitlement"
  | "suspension"
  | "disk_recovery";
const diskRecoveryStages = new Set([
  "capability",
  "idempotency",
  "fenced",
  "traffic",
  "preservation",
  "authorization",
  "identity",
  "readiness",
  "reboot",
  "inventory",
  "backup",
  "pause",
  "normal_resume",
  "final_pause",
  "reconnect",
  "release",
]);

async function assertEligible(
  userId: string,
  consent: RecoveryConsent,
  reportStage: (stage: RecoveryStage) => void = () => {},
): Promise<DiskRecoveryAuthorization> {
  reportStage("manifest");
  const auth = targetAuthorization(userId, consent);
  reportStage("failure_evidence");
  const failures = await readFailures(userId);
  if (
    !failures ||
    !sameTarget(failures, consent.target) ||
    failures.attempts.length < 2 ||
    (failures.uncertain && failures.timeoutOnly !== true) ||
    Date.now() - failures.lastFailedAt > 86400000
  )
    throw new RecoveryUnavailable();
  // A connection deadline is not evidence that the provider stopped. Drain the
  // full idle window and then independently inspect paused identity. The single
  // reboot request must be refused by E2B if a conflicting start is in flight.
  reportStage("idle_window");
  if (failures.uncertain && Date.now() - failures.lastFailedAt < 15 * 60000)
    throw new RecoveryBusy();
  reportStage("workspace_state");
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
  reportStage("activity");
  if (await recoveryRedis().exists(activityKeyFor(userId)))
    throw new RecoveryBusy();
  reportStage("active_runs");
  await assertNoActiveWork(userId);
  reportStage("provider_identity");
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
    typeof info.lifecycle?.autoResume !== "boolean" ||
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
  reportStage("provider_inventory");
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
async function currentRecoveryView(userId: string): Promise<RecoveryView> {
  if (!process.env.CLOUD_DISK_RECOVERY_TARGETS) return { status: "hidden" };
  const active = await enabled(userId);
  let consent = await readConsent(userId);
  if (!active && (!consent || ["offered", "declined"].includes(consent.status)))
    return { status: "hidden" };
  if (consent) {
    const workspace = await readCloudWorkspaceState(userId);
    const result = (await readE2BDiskRecoveryResult(userId)) as {
      token?: string;
      status?: string;
      sandboxId?: string;
      region?: string;
      completedAt?: string;
    } | null;
    if (
      result?.token === consent.token &&
      result.status === "verified_ready" &&
      result.sandboxId === consent.target.sandboxId &&
      result.region === consent.target.region &&
      workspace?.phase === "e2b" &&
      workspace.destinationId === consent.target.sandboxId &&
      workspace.region === consent.target.region &&
      workspace.recoveryPending === undefined
    ) {
      const failures = await readFailures(userId);
      const completedAt = Date.parse(result.completedAt ?? "");
      return {
        status:
          Number.isFinite(completedAt) &&
          (!failures || failures.lastFailedAt <= completedAt)
            ? "recovered"
            : "support",
      };
    }
    // Turning off a rollout prevents new action, but must not hide an incident
    // that already consumed consent or strand the customer without support.
    if (!active) return { status: "support" };
    if (consent.status === "failed") {
      if (consent.failurePhase !== "before_reboot")
        return { status: "support" };
      const failures = await readFailures(userId);
      // Expired incident evidence is not a permanent failed approval. Normal
      // acquisition can establish fresh failures; never manufacture timestamps.
      if (!failures) return { status: "hidden" };
      if (!sameTarget(failures, consent.target)) return { status: "support" };
      try {
        await assertEligible(userId, consent);
      } catch (error) {
        return { status: eligibilityFailureStatus(error) };
      }
      const renewed = await retryPreflightConsent(userId, consent, failures);
      return renewed
        ? { status: "offered", token: renewed.token }
        : { status: "waiting" };
    }
    if (
      workspace?.phase === "recovery" ||
      ["confirmed", "executing"].includes(consent.status)
    ) {
      const started =
        workspace?.phase === "recovery"
          ? Date.parse(workspace.startedAt)
          : (consent.confirmedAt ?? consent.issuedAt);
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
    const currentFailures = await readFailures(userId);
    if (!currentFailures) return { status: "hidden" };
    if (!sameTarget(currentFailures, consent.target)) {
      // Only an unconsumed warning may move to a new incident. Fresh consent
      // and every eligibility check still precede any provider action.
      const renewed = await renewConsent(userId, consent, currentFailures);
      if (!renewed) return { status: "waiting" };
      consent = renewed;
    }
    if (consent.status === "declined")
      return { status: "declined", token: consent.token };
    if (Date.now() - consent.issuedAt > 10 * 60000) {
      // A stale warning can be reviewed again; it never granted permission to act.
      const renewed = await renewConsent(userId, consent);
      if (!renewed) return { status: "waiting" };
      consent = renewed;
    }
    try {
      await assertEligible(userId, consent);
      return { status: "offered", token: consent.token };
    } catch (error) {
      return { status: eligibilityFailureStatus(error) };
    }
  }
  const failures = await readFailures(userId);
  if (!failures || failures.attempts.length < 2) return { status: "hidden" };
  if (failures.uncertain && failures.timeoutOnly !== true)
    return { status: "support" };
  const candidate: RecoveryConsent = {
    token: crypto.randomUUID(),
    target: failures,
    status: "offered",
    issuedAt: Date.now(),
  };
  try {
    await assertEligible(userId, candidate);
  } catch (error) {
    return { status: eligibilityFailureStatus(error) };
  }
  const offered = await offerConsent(userId, failures);
  return offered.status === "offered"
    ? { status: "offered", token: offered.token }
    : { status: "support" };
}
export async function recoveryView(userId: string): Promise<RecoveryView> {
  const view = await currentRecoveryView(userId);
  if (view.status === "hidden") return view;
  const consent = await readConsent(userId);
  const failures = consent ? null : await readFailures(userId);
  const incident = consent?.token ?? failures?.attempts[0];
  return incident ? { ...view, reference: `CR-${incident.slice(0, 8)}` } : view;
}

export async function reopenRecovery(userId: string, token: string) {
  if (!(await enabled(userId))) throw new RecoveryUnavailable();
  const consent = await readConsent(userId);
  if (!consent || consent.token !== token || consent.status !== "declined")
    throw new RecoveryUnavailable();
  await renewConsent(userId, consent);
}

export async function confirmRecovery(
  userId: string,
  token: string,
  confirmed: boolean,
  organizationId?: string,
) {
  if (!(await enabled(userId))) throw new RecoveryUnavailable();
  const consent = await readConsent(userId);
  if (!consent || consent.token !== token) throw new RecoveryUnavailable();
  if (consent.status !== "offered") return null;
  if (Date.now() - consent.issuedAt > 10 * 60000)
    throw new RecoveryUnavailable();
  if (confirmed) {
    if (!organizationId) throw new RecoveryUnavailable();
    await assertEligible(userId, consent);
  }
  if (!(await decideConsent(userId, consent, confirmed, organizationId)))
    return null;
  return confirmed ? consent : null;
}
export async function executeCustomerRecovery(
  userId: string,
  token: string,
  region: ResumeFailures["region"],
) {
  const consent = await readConsent(userId);
  if (!consent || consent.token !== token || consent.status !== "confirmed")
    throw new RecoveryUnavailable();
  let stage: RecoveryStage = "dispatch";
  try {
    // Settle only this still-confirmed receipt. A duplicate worker must never
    // release an executing recovery's fence, even if the rollout was disabled.
    if (consent.target.region !== region || !(await enabled(userId)))
      throw new RecoveryUnavailable();
    stage = "consent_age";
    // A delayed dispatch is not permission to reboot hours after confirmation.
    if (Date.now() - (consent.confirmedAt ?? consent.issuedAt) > 10 * 60000)
      throw new RecoveryUnavailable();
    const auth = await assertEligible(userId, consent, (next) => {
      stage = next;
    });
    stage = "entitlement";
    // Bind billing authority to the authenticated session that granted consent.
    // Legacy receipts without that binding cannot authorize provider work.
    if (!consent.organizationId) throw new RecoveryUnavailable();
    const entitlement = await getCurrentAgentEntitlementContext({
      userId,
      organizationId: consent.organizationId,
    });
    if (entitlement.subscription === "free") throw new RecoveryUnavailable();
    stage = "suspension";
    await assertUserCanMakeCostIncurringRequest(userId);
    stage = "disk_recovery";
    await recoverE2BDiskOnly(auth, {
      consentKey: consentKey(userId),
      assertIdle: () => assertNoActiveWork(userId),
    });
    phLogger.event("cloud_workspace_customer_recovery_completed", {
      userId,
      outcome: "verified",
    });
  } catch (error) {
    await failConsent(userId, token).catch(() => {});
    phLogger.event("cloud_workspace_customer_recovery_completed", {
      userId,
      outcome: "support_required",
      recovery_stage: stage,
      recovery_reason:
        error instanceof RecoveryBusy
          ? "busy"
          : error instanceof RecoveryUnavailable
            ? "ineligible"
            : "operation_failed",
      ...(error instanceof DiskRecoveryError &&
      diskRecoveryStages.has(error.stage)
        ? { disk_recovery_stage: error.stage }
        : {}),
    });
    // No provider error messages, snapshots, workspace ids or authorization in task output.
    throw new RecoveryUnavailable("Recovery requires support reconciliation");
  } finally {
    // The short-lived worker may exit with fewer events than the batch threshold.
    // Analytics delivery must never change the durable recovery outcome.
    await phLogger.flush().catch(() => {});
  }
  return { status: "verified" };
}
