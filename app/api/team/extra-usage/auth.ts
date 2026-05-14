import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

/**
 * Resolve org + admin status from a request. Used by all team extra-usage
 * admin routes. On any guard failure, returns a ready-to-return NextResponse.
 */
export async function requireAdminOrg(
  req: NextRequest,
): Promise<
  | { ok: true; organizationId: string; userId: string }
  | { ok: false; response: NextResponse }
> {
  const { userId, subscription } = await getUserIDAndPro(req);

  if (subscription !== "team") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
      ),
    };
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    statuses: ["active"],
  });

  if (!memberships.data || memberships.data.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      ),
    };
  }

  const userMembership = memberships.data[0];
  if (userMembership.role?.slug !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Admin role required" },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    organizationId: userMembership.organizationId,
    userId,
  };
}
