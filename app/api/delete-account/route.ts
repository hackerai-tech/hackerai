import { NextRequest, NextResponse } from "next/server";
import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserID } from "@/lib/auth/get-user-id";

export const POST = async (req: NextRequest) => {
  try {
    const userId = await getUserID(req);

    // List all org memberships for this user
    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        userId,
      },
    );

    // Process each organization from memberships: cancel at most one active Stripe subscription and remove org
    await Promise.all(
      memberships.data.map(async (membership) => {
        const orgId = membership.organizationId;

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

        // Try to delete the WorkOS organization entirely
        try {
          // Prefer deleting the organization; if it fails (e.g., shared org), fall back to removing membership
          await workos.organizations.deleteOrganization(orgId);
        } catch (orgDeleteErr) {
          console.warn(
            "Failed to delete organization, removing membership instead:",
            orgId,
            orgDeleteErr,
          );
          try {
            await workos.userManagement.deleteOrganizationMembership(
              membership.id,
            );
          } catch (memErr) {
            console.error(
              "Failed to delete organization membership:",
              membership.id,
              memErr,
            );
          }
        }
      }),
    );

    // Finally, delete the WorkOS user
    await workos.userManagement.deleteUser(userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in (error as any)
        ? (error as any).message
        : "Failed to cancel subscriptions and remove organizations";
    console.error("Failed to cancel subscriptions and remove orgs:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
};
