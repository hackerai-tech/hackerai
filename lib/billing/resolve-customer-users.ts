import { stripe } from "@/app/api/stripe";
import { workos } from "@/app/api/workos";
import Stripe from "stripe";

export type CustomerUserResolutionReason =
  | "customer_deleted"
  | "missing_workos_organization_metadata"
  | "no_active_memberships"
  | "lookup_failed";

export type CustomerUserResolution = {
  userIds: string[];
  orgId: string | null;
  reason?: CustomerUserResolutionReason;
};

export async function resolveUserIdsFromCustomer(
  customerId: string,
  logPrefix: string,
): Promise<CustomerUserResolution> {
  try {
    const customerData = await stripe.customers.retrieve(customerId);
    if (customerData.deleted) {
      return { userIds: [], orgId: null, reason: "customer_deleted" };
    }

    const customer = customerData as Stripe.Customer;
    const orgId = customer.metadata?.workOSOrganizationId ?? null;
    if (!orgId) {
      console.error(
        `[${logPrefix}] Customer ${customerId} missing workOSOrganizationId metadata`,
      );
      return {
        userIds: [],
        orgId: null,
        reason: "missing_workos_organization_metadata",
      };
    }

    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        organizationId: orgId,
        statuses: ["active"],
      },
    );

    const allMemberships = await memberships.autoPagination();
    const userIds = allMemberships.map((membership) => membership.userId);

    if (userIds.length === 0) {
      console.error(`[${logPrefix}] No active memberships for org ${orgId}`);
      return { userIds: [], orgId, reason: "no_active_memberships" };
    }

    return { userIds, orgId };
  } catch (error) {
    console.error(
      `[${logPrefix}] Failed to resolve users for customer ${customerId}:`,
      error,
    );
    return { userIds: [], orgId: null, reason: "lookup_failed" };
  }
}
