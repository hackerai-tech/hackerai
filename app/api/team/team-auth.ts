import { NextRequest, NextResponse } from "next/server";
import { workos } from "../workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

type Membership = Awaited<
  ReturnType<typeof workos.userManagement.listOrganizationMemberships>
>["data"][number];

/**
 * Resolve the caller's org membership. Use this for any /api/team/* route
 * that requires the user to be on a team plan. Returns a ready-to-return
 * NextResponse for the guard failures.
 *
 * Caller decides whether to require admin role — for admin-only routes,
 * prefer requireAdminOrg below.
 */
export async function requireTeamOrg(
  req: NextRequest,
): Promise<
  | { ok: true; organizationId: string; userId: string; membership: Membership }
  | { ok: false; response: NextResponse }
> {
  const { userId, subscription, organizationId } = await getUserIDAndPro(req);

  if (subscription !== "team") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
      ),
    };
  }

  // Use the active org from the session rather than picking an arbitrary one
  // — a user can belong to multiple orgs and we must operate on the one they
  // are currently authenticated against.
  if (!organizationId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No active organization" },
        { status: 403 },
      ),
    };
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    organizationId,
    statuses: ["active"],
  });

  const membership = memberships.data?.[0];
  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      ),
    };
  }

  return {
    ok: true,
    organizationId,
    userId,
    membership,
  };
}

/**
 * Like requireTeamOrg but also rejects non-admins. Use this for routes
 * that mutate org-scoped state (invites, seats, team extra usage).
 *
 * On 403 the message names admin-only specifically — callers may override
 * with their own error copy before returning if they want different wording.
 */
export async function requireAdminOrg(
  req: NextRequest,
): Promise<
  | { ok: true; organizationId: string; userId: string; membership: Membership }
  | { ok: false; response: NextResponse }
> {
  const result = await requireTeamOrg(req);
  if (!result.ok) return result;

  if (result.membership.role?.slug !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Admin role required" },
        { status: 403 },
      ),
    };
  }

  return result;
}
