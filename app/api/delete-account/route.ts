import { NextRequest, NextResponse } from "next/server";
import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserIDWithFreshLoginContext } from "@/lib/auth/get-user-id";
import { deleteUserRateLimitKeys } from "@/lib/rate-limit/token-bucket";
import { ChatSDKError } from "@/lib/errors";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { logger } from "@/lib/logger";
import { fenceAndGetActiveAgentResourcesForUser } from "@/lib/db/actions";
import { closeAndCancelAgentResources } from "@/lib/api/agent-deletion-cleanup";

type OrganizationMembership = Awaited<
  ReturnType<typeof workos.userManagement.listOrganizationMemberships>
>["data"][number];

type MembershipDeletionPlan = {
  membership: OrganizationMembership;
  deleteOrganization: boolean;
  blockReason?: string;
};

const MAX_CONVEX_ACCOUNT_CLEANUP_BATCHES = 50;

type ConvexCleanupProgress = {
  deletedDocuments: number;
  anonymizedDocuments: number;
  s3ObjectsQueued: number;
};

type ParsedConvexCleanupResult = {
  hasMore: boolean;
  progress?: ConvexCleanupProgress;
};

function isMissingWorkosUserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "NotFoundException" &&
    error.message.startsWith("User not found:")
  );
}

function sumCleanupCounts(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  let total = 0;
  for (const count of Object.values(value)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return undefined;
    }
    total += count;
  }
  return total;
}

function parseConvexCleanupResult(result: unknown): ParsedConvexCleanupResult {
  if (
    result &&
    typeof result === "object" &&
    typeof (result as { hasMore?: unknown }).hasMore === "boolean"
  ) {
    const cleanupResult = result as Record<string, unknown> & {
      hasMore: boolean;
    };
    const deletedDocuments = sumCleanupCounts(cleanupResult.deleted);
    const anonymizedDocuments = sumCleanupCounts(cleanupResult.anonymized);
    const s3ObjectsQueued = cleanupResult.s3ObjectsQueued;
    const progress =
      deletedDocuments !== undefined &&
      anonymizedDocuments !== undefined &&
      typeof s3ObjectsQueued === "number" &&
      Number.isFinite(s3ObjectsQueued) &&
      s3ObjectsQueued >= 0
        ? { deletedDocuments, anonymizedDocuments, s3ObjectsQueued }
        : undefined;

    return { hasMore: cleanupResult.hasMore, progress };
  }

  throw new Error(
    "Account cleanup returned an unexpected response. Please contact support so we can finish deleting this account.",
  );
}

async function removeMembership(membership: OrganizationMembership) {
  try {
    await workos.userManagement.deleteOrganizationMembership(membership.id);
  } catch (memErr) {
    console.error(
      "Failed to delete organization membership:",
      membership.id,
      memErr,
    );
  }
}

async function getMembershipDeletionPlan(
  membership: OrganizationMembership,
): Promise<MembershipDeletionPlan> {
  try {
    const activeMembershipsPage =
      await workos.userManagement.listOrganizationMemberships({
        organizationId: membership.organizationId,
        statuses: ["active"],
      });
    const activeMemberships = activeMembershipsPage.data;
    const activeCallerMembership = activeMemberships.find(
      (activeMembership) => activeMembership.id === membership.id,
    );
    const isSoleActiveMember =
      activeMemberships.length === 1 &&
      activeCallerMembership?.id === membership.id;
    const isAdmin =
      membership.role?.slug === "admin" ||
      activeCallerMembership?.role?.slug === "admin";
    const activeAdminCount = activeMemberships.filter(
      (activeMembership) => activeMembership.role?.slug === "admin",
    ).length;

    if (!isSoleActiveMember && isAdmin && activeAdminCount <= 1) {
      return {
        membership,
        deleteOrganization: false,
        blockReason:
          "Cannot delete account while you are the last admin of a shared organization. Promote another admin or leave the team first.",
      };
    }

    return {
      membership,
      deleteOrganization: isSoleActiveMember && isAdmin,
    };
  } catch (e) {
    console.warn(
      "Failed to verify organization membership count; removing membership only:",
      membership.organizationId,
      e,
    );
    return { membership, deleteOrganization: false };
  }
}

function getConvexServiceKey(): string {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("CONVEX_SERVICE_ROLE_KEY is not set");
  }
  return serviceKey;
}

async function markAccountIdentityDeleted(
  userId: string,
  freeQuotaSubject: string | undefined,
  serviceKey: string,
) {
  if (!freeQuotaSubject) return;

  await getConvexClient().mutation(api.accountIdentities.markDeleted, {
    serviceKey,
    identityHash: freeQuotaSubject,
    userId,
  });
}

async function deleteConvexUserData(
  userId: string,
  serviceKey: string,
  requestId: string,
) {
  const convex = getConvexClient();
  let progressStatsBatches = 0;
  let batchesWithProgress = 0;
  let deletedDocuments = 0;
  let anonymizedDocuments = 0;
  let s3ObjectsQueued = 0;
  let lastProgress: ConvexCleanupProgress | undefined;

  for (let batch = 0; batch < MAX_CONVEX_ACCOUNT_CLEANUP_BATCHES; batch++) {
    const result = await convex.mutation(
      api.userDeletion.deleteAllUserDataByService,
      {
        serviceKey,
        userId,
      },
    );

    const parsedResult = parseConvexCleanupResult(result);
    if (parsedResult.progress) {
      progressStatsBatches += 1;
      deletedDocuments += parsedResult.progress.deletedDocuments;
      anonymizedDocuments += parsedResult.progress.anonymizedDocuments;
      s3ObjectsQueued += parsedResult.progress.s3ObjectsQueued;
      if (
        parsedResult.progress.deletedDocuments > 0 ||
        parsedResult.progress.anonymizedDocuments > 0
      ) {
        batchesWithProgress += 1;
      }
      lastProgress = parsedResult.progress;
    }

    if (!parsedResult.hasMore) {
      return;
    }
  }

  logger.error("account_cleanup_batch_limit_exhausted", undefined, {
    event: "account_cleanup_batch_limit_exhausted",
    service: "hackerai-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    request_id: requestId,
    user_id: userId,
    reason: "cleanup_batch_limit_exhausted",
    batch_limit: MAX_CONVEX_ACCOUNT_CLEANUP_BATCHES,
    progress_stats_batches: progressStatsBatches,
    batches_with_progress: batchesWithProgress,
    deleted_documents: deletedDocuments,
    anonymized_documents: anonymizedDocuments,
    s3_objects_queued: s3ObjectsQueued,
    last_batch_deleted_documents: lastProgress?.deletedDocuments,
    last_batch_anonymized_documents: lastProgress?.anonymizedDocuments,
    last_batch_s3_objects_queued: lastProgress?.s3ObjectsQueued,
  });

  throw new Error(
    "Account cleanup is taking longer than expected. Please contact support so we can finish deleting this account.",
  );
}

export const POST = async (req: NextRequest) => {
  let stage = "authenticate";
  let userIdForLog: string | undefined;
  let membershipCount: number | undefined;
  let freeQuotaSubjectPresent: boolean | undefined;
  const requestId = req.headers.get("x-vercel-id") ?? "unknown";

  try {
    // Enforce recent login (10-minute window) before any destructive action
    const { userId, freeQuotaSubject } =
      await getUserIDWithFreshLoginContext(req);
    userIdForLog = userId;
    freeQuotaSubjectPresent = Boolean(freeQuotaSubject);

    // List all org memberships for this user
    // NOTE: Pagination not required - users can only have one organization (max 2 if something goes wrong)
    stage = "list_memberships";
    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        userId,
      },
    );
    membershipCount = memberships.data.length;

    stage = "plan_membership_deletions";
    const membershipDeletionPlans = await Promise.all(
      memberships.data.map(getMembershipDeletionPlan),
    );
    const blockedPlan = membershipDeletionPlans.find(
      (plan) => plan.blockReason,
    );

    if (blockedPlan?.blockReason) {
      return NextResponse.json(
        { error: blockedPlan.blockReason },
        { status: 400 },
      );
    }

    const serviceKey = getConvexServiceKey();
    stage = "mark_account_identity_deleted";
    await markAccountIdentityDeleted(userId, freeQuotaSubject, serviceKey);

    stage = "fence_active_agent_resources";
    const activeAgentResources = await fenceAndGetActiveAgentResourcesForUser({
      userId,
    });
    if (activeAgentResources.hasMore) {
      throw new Error(
        "Too many active agent resources to delete safely. Please stop active Agent runs and retry.",
      );
    }

    stage = "close_active_agent_resources";
    await closeAndCancelAgentResources(
      activeAgentResources.resources,
      "account-deleted",
    );

    // Own app-data cleanup on the server so account deletion does not depend
    // on the browser successfully running a Convex mutation before this route.
    stage = "delete_convex_user_data";
    await deleteConvexUserData(userId, serviceKey, requestId);

    // Process each organization from memberships. Only delete org-level billing
    // and identity resources after proving this user is the sole active admin.
    stage = "delete_memberships_and_organizations";
    await Promise.all(
      membershipDeletionPlans.map(
        async ({ membership, deleteOrganization }) => {
          const orgId = membership.organizationId;

          if (!deleteOrganization) {
            await removeMembership(membership);
            return;
          }

          // Load organization to get Stripe customer ID if present
          let org: any = null;
          try {
            org = await workos.organizations.getOrganization(orgId);
          } catch (e) {
            console.warn("Failed to load organization:", orgId, e);
          }

          const stripeCustomerId: string | undefined = org?.stripeCustomerId;

          // Cancel all subscriptions for the Stripe customer (no status checks), then delete the customer
          if (stripeCustomerId) {
            const subs = await stripe.subscriptions.list({
              customer: stripeCustomerId,
              status: "all",
              limit: 100,
            });

            // Cancel subscriptions, continue on failures
            for (const sub of subs.data) {
              try {
                await stripe.subscriptions.cancel(sub.id as string);
              } catch (subErr) {
                console.warn(
                  "Failed to cancel subscription, continuing:",
                  sub.id,
                  subErr,
                );
              }
            }

            // Delete the Stripe customer after cancellations
            try {
              await stripe.customers.del(stripeCustomerId);
            } catch (custErr) {
              console.error(
                "Failed to delete Stripe customer:",
                stripeCustomerId,
                custErr,
              );
            }
          }

          // Delete the WorkOS organization only for verified single-member orgs.
          try {
            await workos.organizations.deleteOrganization(orgId);
          } catch (orgDeleteErr) {
            console.warn(
              "Failed to delete organization, removing membership instead:",
              orgId,
              orgDeleteErr,
            );
            await removeMembership(membership);
          }
        },
      ),
    );

    // Purge Redis rate-limit keys. Best-effort: WorkOS user deletion proceeds
    // even if this fails so the account is not left in a half-deleted state.
    stage = "delete_rate_limit_keys";
    await deleteUserRateLimitKeys(userId).catch((err) => {
      console.warn(
        "Failed to clear Redis rate-limit keys during account deletion:",
        err,
      );
    });

    // Finally, delete the WorkOS user
    stage = "delete_workos_user";
    try {
      await workos.userManagement.deleteUser(userId);
    } catch (error) {
      // Account deletion is idempotent once all owned app data is gone.
      // WorkOS can report this exact state when a previous attempt already
      // removed the external identity but the client retried the request.
      if (!isMissingWorkosUserError(error)) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    const message =
      error && typeof error === "object" && "message" in (error as any)
        ? (error as any).message
        : "Failed to delete account";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error(
      "account_deletion_failed",
      error instanceof Error ? error : undefined,
      {
        event: "account_deletion_failed",
        service: "hackerai-web",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        request_id: requestId,
        stage,
        user_id: userIdForLog,
        membership_count: membershipCount,
        free_quota_subject_present: freeQuotaSubjectPresent,
        error_name: errorName,
        error_message: message,
      },
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
};
