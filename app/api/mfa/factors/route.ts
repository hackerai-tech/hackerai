import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { workos } from "@/app/api/workos";
import { isUnauthorizedError } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  try {
    // Get authenticated user
    let userId: string;
    try {
      userId = await getUserID(req);
    } catch (e) {
      const status = isUnauthorizedError(e) ? 401 : 500;
      return NextResponse.json(
        {
          error: status === 401 ? "Unauthorized" : "Failed to get MFA factors",
        },
        { status },
      );
    }

    // Get user's MFA factors from WorkOS
    const factors = await workos.userManagement.listAuthFactors({
      userId: userId,
    });

    // Transform factors for client response
    const transformedFactors = factors.data.map((factor) => ({
      id: factor.id,
      type: factor.type,
      issuer: factor.totp?.issuer,
      user: factor.totp?.user,
      createdAt: factor.createdAt,
      updatedAt: factor.updatedAt,
    }));

    return NextResponse.json({
      factors: transformedFactors,
    });
  } catch (error) {
    console.error("Get MFA factors error:", error);
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to get MFA factors" },
      { status },
    );
  }
}
