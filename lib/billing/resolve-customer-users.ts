import { stripe } from "@/app/api/stripe";
import { workos } from "@/app/api/workos";
import Stripe from "stripe";

/** Why a Stripe customer could not be mapped to active WorkOS users. */
export type CustomerUserResolutionReason =
  | "customer_deleted"
  | "legacy_user_metadata"
  | "missing_workos_organization_metadata"
  | "no_active_memberships"
  | "lookup_failed";

/** Active WorkOS users for a Stripe customer, or a reason none were resolved. */
export type CustomerUserResolution = {
  userIds: string[];
  orgId: string | null;
  reason?: CustomerUserResolutionReason;
  legacyUserId?: string;
};

const LEGACY_USER_METADATA_KEYS = ["userId", "firebaseUID"] as const;

function legacyUserIdFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | null {
  for (const key of LEGACY_USER_METADATA_KEYS) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Resolve active WorkOS user IDs for a Stripe customer. */
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
      const legacyUserId = legacyUserIdFromMetadata(customer.metadata);
      if (legacyUserId) {
        console.warn(
          `[${logPrefix}] Customer ${customerId} has legacy user metadata but no workOSOrganizationId metadata`,
        );
        return {
          userIds: [],
          orgId: null,
          reason: "legacy_user_metadata",
          legacyUserId,
        };
      }

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
