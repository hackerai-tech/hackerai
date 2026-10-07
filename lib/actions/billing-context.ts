"use server";

import { workos } from "@/app/api/workos";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";

export type BillingActionContext = {
  organizationId: string;
  user: NonNullable<Awaited<ReturnType<typeof withAuth>>["user"]>;
  stripeCustomerId: string;
};

export async function getBillingActionContext(): Promise<BillingActionContext> {
  const context = await resolveBillingContext(false);
  if (!context) throw new Error("No organization found");
  return context;
}

/** Read-only status can distinguish a new free user from an unscoped paid user. */
export async function getBillingStatusContext(): Promise<BillingActionContext | null> {
  return resolveBillingContext(true);
}

async function resolveBillingContext(
  allowUnscopedStatus: boolean,
): Promise<BillingActionContext | null> {
  let authResult: Awaited<ReturnType<typeof withAuth>>;
  try {
    authResult = await withAuth();
  } catch (error) {
    if (isEndedSessionRefreshError(error)) {
      throw new Error("User not authenticated", { cause: error });
    }
    throw error;
  }

  const { user } = authResult;
  let { organizationId } = authResult;

  if (!user?.id) {
    throw new Error("User not authenticated");
  }

  if (!organizationId && !allowUnscopedStatus) {
    throw new Error("No organization found");
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: user.id,
    ...(organizationId && { organizationId }),
    statuses: ["active"],
  });

  const activeMemberships = organizationId
    ? memberships.data
    : await memberships.autoPagination();
  if (!organizationId) {
    // No memberships is normal before first checkout. Never mistake an
    // unselected existing organization (possibly past due) for a free account.
    if (activeMemberships.length === 0) return null;
    if (activeMemberships.length !== 1) {
      throw new Error("No organization found");
    }
    organizationId = activeMemberships[0].organizationId;
  }

  const userMembership = activeMemberships[0];
  if (!userMembership) {
    throw new Error("User is not a member of this organization");
  }

  if (
    userMembership.role?.slug !== "admin" &&
    userMembership.role?.slug !== "owner"
  ) {
    throw new Error("Only admins or owners can manage billing");
  }

  const response = await fetch(
    `${workos.baseURL}/organizations/${organizationId}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.WORKOS_API_KEY}`,
        "content-type": "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error("Failed to fetch organization details");
  }
  const workosOrg = await response.json();

  if (!workosOrg?.stripe_customer_id) {
    if (allowUnscopedStatus) return null;
    throw new Error("No billing account found for this organization");
  }

  return {
    organizationId,
    user,
    stripeCustomerId: workosOrg.stripe_customer_id,
  };
}
