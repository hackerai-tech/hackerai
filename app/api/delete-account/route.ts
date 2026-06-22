import { NextRequest, NextResponse } from "next/server";
import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserIDWithFreshLoginContext } from "@/lib/auth/get-user-id";
import { deleteUserRateLimitKeys } from "@/lib/rate-limit/token-bucket";
import { ChatSDKError } from "@/lib/errors";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";

type OrganizationMembership = Awaited<
  ReturnType<typeof workos.userManagement.listOrganizationMemberships>
>["data"][number];

type MembershipDeletionPlan = {
  membership: OrganizationMembership;
  deleteOrganization: boolean;
  blockReason?: string;
};

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

async function deleteConvexUserData(userId: string, serviceKey: string) {
  await getConvexClient().mutation(
    api.userDeletion.deleteAllUserDataByService,
    {
      serviceKey,
      userId,
    },
  );
}

export const POST = async (req: NextRequest) => {
  try {
    // Enforce recent login (10-minute window) before any destructive action
    const { userId, freeQuotaSubject } =
      await getUserIDWithFreshLoginContext(req);

    // List all org memberships for this user
    // NOTE: Pagination not required - users can only have one organization (max 2 if something goes wrong)
    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        userId,
      },
    );

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
    await markAccountIdentityDeleted(userId, freeQuotaSubject, serviceKey);

    // Own app-data cleanup on the server so account deletion does not depend
    // on the browser successfully running a Convex mutation before this route.
    await deleteConvexUserData(userId, serviceKey);

    // Process each organization from memberships. Only delete org-level billing
    // and identity resources after proving this user is the sole active admin.
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
    await deleteUserRateLimitKeys(userId).catch((err) => {
      console.warn(
        "Failed to clear Redis rate-limit keys during account deletion:",
        err,
      );
    });

    // Finally, delete the WorkOS user
    await workos.userManagement.deleteUser(userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    const message =
      error && typeof error === "object" && "message" in (error as any)
        ? (error as any).message
        : "Failed to cancel subscriptions and remove organizations";
    console.error("Failed to cancel subscriptions and remove orgs:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
};
