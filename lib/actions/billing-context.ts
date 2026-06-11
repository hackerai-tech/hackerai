"use server";

import { workos } from "@/app/api/workos";
import { withAuth } from "@workos-inc/authkit-nextjs";

export type BillingActionContext = {
  organizationId: string;
  user: NonNullable<Awaited<ReturnType<typeof withAuth>>["user"]>;
  stripeCustomerId: string;
};

export async function getBillingActionContext(): Promise<BillingActionContext> {
  const { organizationId, user } = await withAuth();

  if (!user?.id) {
    throw new Error("User not authenticated");
  }

  if (!organizationId) {
    throw new Error("No organization found");
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: user.id,
    organizationId,
    statuses: ["active"],
  });

  const userMembership = memberships.data[0];
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
    throw new Error("No billing account found for this organization");
  }

  return {
    organizationId,
    user,
    stripeCustomerId: workosOrg.stripe_customer_id,
  };
}
