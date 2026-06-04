import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { isUnauthorizedError } from "@/lib/api/response";
import { listUserMfaFactors } from "@/app/api/mfa/workos-factors";

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

    const factors = await listUserMfaFactors(userId);

    return NextResponse.json({
      factors,
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
