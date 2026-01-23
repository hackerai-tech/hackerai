"use server";

import { stripe } from "../../app/api/stripe";
import { workos } from "@/app/api/workos";
import { withAuth } from "@workos-inc/authkit-nextjs";

export default async function redirectToBillingPortal() {
  const { organizationId, user } = await withAuth();

  if (!user?.id) {
    throw new Error("User not authenticated");
  }

  if (!organizationId) {
    throw new Error("No organization found");
  }

  // Check if user is an admin of the organization (for team subscriptions)
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: user.id,
    organizationId,
    statuses: ["active"],
  });

  const userMembership = memberships.data[0];
  if (!userMembership) {
    throw new Error("User is not a member of this organization");
  }

  // Only admins can access billing portal for team subscriptions
  if (userMembership.role?.slug !== "admin") {
    throw new Error("Only admins can manage billing");
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

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const billingPortalSession = await stripe.billingPortal.sessions.create({
    customer: workosOrg.stripe_customer_id,
    return_url: `${baseUrl}`,
  });

  if (!billingPortalSession?.url) {
    throw new Error("Failed to create billing portal session");
  }
  return billingPortalSession.url;
}
