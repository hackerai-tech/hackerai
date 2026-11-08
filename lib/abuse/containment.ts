import "server-only";
import { Sandbox } from "@e2b/code-interpreter";
import { NotFoundError } from "e2b";
import { runs } from "@trigger.dev/sdk";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { getConvexClient, getConvexUrl } from "@/lib/db/convex-client";
import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  claimCloudWorkspaceCleanup,
  readCloudWorkspaceState,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { isDesktopPreference } from "@/lib/sandbox/environment";

type Scope = NonNullable<Doc<"abuse_cases">["containment"]>;
const TERMINAL = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

function cloudOptions(region: string | undefined) {
  if (!["us-east-1", "us-west-2", "eu-central-1"].includes(region ?? ""))
    throw new Error("Unverified region");
  const cluster = getE2BClusterRouting(
    region as TriggerRunRegion,
  ).createCluster;
  return { ...cluster.connectionOptions, requestTimeoutMs: 15_000 };
}

/** Do not select targets from report text: ownership comes from stored runtime identity. */
export async function verifyContainmentTarget(input: {
  userId: string;
  chatId: string;
  runId: string;
  sandboxId?: string;
  region?: string;
}): Promise<"cloud" | "local" | "desktop"> {
  const run = await runs.retrieve(input.runId);
  const payload = run.payload as {
    userId?: string;
    chatId?: string;
    convexUrl?: string;
    sandboxPreference?: string;
    triggerRegion?: string;
  };
  if (
    run.taskIdentifier !== "agent-long" ||
    payload.userId !== input.userId ||
    payload.chatId !== input.chatId ||
    (payload.convexUrl && payload.convexUrl !== getConvexUrl())
  )
    throw new Error("Run identity mismatch");
  const preference = payload.sandboxPreference ?? "e2b";
  const transport =
    preference === "e2b"
      ? "cloud"
      : isDesktopPreference(preference)
        ? "desktop"
        : "local";
  if (transport === "cloud") {
    if (
      !input.sandboxId ||
      input.region !== (payload.triggerRegion ?? "us-east-1")
    )
      throw new Error("Workspace identity required");
    const state = await readCloudWorkspaceState(input.userId);
    if (
      state?.phase !== "e2b" ||
      state.destinationId !== input.sandboxId ||
      state.region !== input.region
    )
      throw new Error("Workspace selection changed");
    const info = await Sandbox.getInfo(
      input.sandboxId,
      cloudOptions(input.region),
    );
    if (
      info.sandboxId !== input.sandboxId ||
      info.metadata?.userID !== input.userId
    )
      throw new Error("Sandbox ownership mismatch");
  } else if (input.sandboxId || input.region)
    throw new Error("Cloud fields do not match this run");
  return transport;
}

export async function findAbuseSnapshot(scope: Scope) {
  if (!scope.snapshotName) return undefined;
  const paginator = Sandbox.listSnapshots({
    ...cloudOptions(scope.region),
    sandboxId: scope.sandboxId!,
    name: scope.snapshotName,
    limit: 2,
  });
  const snapshots = await paginator.nextItems();
  if (snapshots.length > 1 || paginator.hasNext)
    throw new Error("Ambiguous snapshot identity");
  const existing = snapshots[0];
  if (
    existing &&
    !existing.names.some(
      (name) => name.split("/").at(-1)?.split(":")[0] === scope.snapshotName,
    )
  )
    throw new Error("Snapshot name mismatch");
  if (scope.snapshotId && existing?.snapshotId !== scope.snapshotId)
    throw new Error("Preserved snapshot unavailable");
  return existing?.snapshotId;
}

async function snapshotForCase(scope: Scope) {
  const existing = await findAbuseSnapshot(scope);
  if (existing) return existing;
  const snapshot = await Sandbox.createSnapshot(scope.sandboxId!, {
    ...cloudOptions(scope.region),
    requestTimeoutMs: 120_000,
    name: scope.snapshotName!,
  });
  const readback = await findAbuseSnapshot(scope);
  if (readback !== snapshot.snapshotId)
    throw new Error("Snapshot could not be verified");
  return snapshot.snapshotId;
}

async function sandboxAbsent(scope: Scope) {
  try {
    const info = await Sandbox.getInfo(
      scope.sandboxId!,
      cloudOptions(scope.region),
    );
    if (
      info.metadata?.userID !== scope.userId ||
      info.sandboxId !== scope.sandboxId
    )
      throw new Error("Sandbox ownership mismatch");
    return false;
  } catch (error) {
    if (error instanceof NotFoundError) return true;
    throw error;
  }
}

/** The caller must first acquire the case's exclusive, expiring operation token. */
export async function executeAbuseContainment(
  row: Doc<"abuse_cases">,
  actor: string,
) {
  if (!row.containment || !row.operationToken)
    throw new Error("Containment operation unavailable");
  let scope = { ...row.containment };
  const client = getConvexClient();
  const args = {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    actor,
    reference: row.reference,
    operationToken: row.operationToken,
  };
  const persist = async (finished: boolean) => {
    await client.mutation(api.abuseCases.recordContainment, {
      ...args,
      containment: scope,
      finished,
    });
  };
  let fence: Awaited<ReturnType<typeof claimCloudWorkspaceCleanup>> | undefined;
  let fenceFinished = false;
  let cloudReady = scope.transport !== "cloud";
  try {
    if (scope.transport === "cloud") {
      const absent = await sandboxAbsent(scope);
      const state = await readCloudWorkspaceState(scope.userId);
      if (absent && scope.snapshotRequested && !scope.snapshotId)
        throw new Error("No preserved snapshot for missing sandbox");
      if (state !== null) {
        fence = await claimCloudWorkspaceCleanup(scope.userId, false, {
          token: `abuse:${row.reference}`,
          sandboxId: scope.sandboxId!,
          region: scope.region as TriggerRunRegion,
        });
      } else if (!absent || (scope.snapshotRequested && !scope.snapshotId))
        throw new Error("Workspace selection unavailable");
      if (scope.snapshotRequested || scope.snapshotId) {
        scope.snapshotId = await snapshotForCase(scope);
        scope.snapshotReviewPending = false;
      } else if (scope.snapshotName) {
        // Emergency stop never forgets a snapshot request that may have completed
        // before the HTTP process died. A provider outage leaves a durable review flag.
        try {
          scope.snapshotId = await findAbuseSnapshot(scope);
          scope.snapshotReviewPending = false;
        } catch {
          scope.snapshotReviewPending = true;
        }
      }
      await persist(false); // No destructive provider action before durable preservation.
      cloudReady = true;
    }
  } catch {
    // Keep cancellation available even when provider preservation needs follow-up.
  }
  try {
    const ids = [scope.runId, ...scope.childRunIds];
    const cancellations = await Promise.allSettled(
      ids.map((id) => cancelAgentTriggerRun(id)),
    );
    const approval = await closeAgentApprovalSession(
      scope.approvalSessionId,
      "reviewed_security_abuse",
    ).then(
      () => true,
      () => false,
    );
    if (
      cancellations.every((result) => result.status === "fulfilled") &&
      approval
    ) {
      const statuses = await Promise.allSettled(
        ids.map((id) => runs.retrieve(id)),
      );
      if (
        statuses.every(
          (result) =>
            result.status === "fulfilled" && TERMINAL.has(result.value.status),
        )
      )
        scope.triggerState = "stopped";
    }
    if (scope.transport === "cloud" && cloudReady) {
      if (!(await sandboxAbsent(scope)))
        await Sandbox.kill(scope.sandboxId!, cloudOptions(scope.region));
      if (!(await sandboxAbsent(scope)))
        throw new Error("Provider process stop unconfirmed");
      // Persist process proof before releasing the workspace fence. An interrupted
      // finalization can resume only this case's exact fence and workspace.
      scope.processState = "provider_stopped";
      await persist(false);
      if (fence) await fence.finish(true);
      fenceFinished = true;
      scope.workspaceState = "released";
    }
  } catch {
    // Partial progress is durable. Never call Trigger cancellation process proof.
  } finally {
    if (fence && !fenceFinished && scope.processState !== "provider_stopped") {
      // A preserved account restriction still blocks acquisitions after rollback.
      await fence.finish(false).catch(() => undefined);
    }
    await persist(true);
  }
  return { processState: scope.processState, triggerState: scope.triggerState };
}

/** A reviewed exoneration can restore the original selection without destroying it. */
export async function prepareAbuseResolution(
  row: Doc<"abuse_cases">,
  actor: string,
) {
  if (!row.containment || !row.operationToken)
    throw new Error("Resolution operation unavailable");
  const scope = { ...row.containment };
  let restored = false;
  try {
    const absent = await sandboxAbsent(scope);
    const state = await readCloudWorkspaceState(scope.userId);
    if (state !== null) {
      const fence = await claimCloudWorkspaceCleanup(scope.userId, false, {
        token: `abuse:${row.reference}`,
        sandboxId: scope.sandboxId!,
        region: scope.region as TriggerRunRegion,
      });
      await fence.finish(absent);
    } else if (!absent) throw new Error("Workspace selection unavailable");
    scope.workspaceState = absent ? "released" : "restored";
    if (absent) scope.processState = "provider_stopped";
    restored = true;
  } finally {
    await getConvexClient().mutation(api.abuseCases.recordContainment, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      actor,
      reference: row.reference,
      operationToken: row.operationToken,
      containment: scope,
      finished: true,
    });
  }
  if (!restored) throw new Error("Workspace restoration unconfirmed");
}
