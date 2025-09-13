import { NextRequest, NextResponse } from "next/server";
import { workos } from "@/app/api/workos";
import { getUserID } from "@/lib/auth/get-user-id";
import { isUnauthorizedError } from "@/lib/api/response";

export async function POST(req: NextRequest) {
  try {
    // Get authenticated user
    let userId: string;
    try {
      userId = await getUserID(req);
    } catch (e) {
      const status = isUnauthorizedError(e) ? 401 : 500;
      return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Failed to enroll MFA factor" }, { status });
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Enroll authentication factor with WorkOS
    const result = await workos.userManagement.enrollAuthFactor({
      userId: userId,
      type: "totp",
      totpIssuer: "HackerAI",
    });

    // Return factor and challenge details
    return NextResponse.json({
      factor: {
        id: result.authenticationFactor.id,
        type: result.authenticationFactor.type,
        qrCode: result.authenticationFactor.totp?.qrCode,
        secret: result.authenticationFactor.totp?.secret,
        issuer: result.authenticationFactor.totp?.issuer,
        user: result.authenticationFactor.totp?.user,
      },
      challenge: {
        id: result.authenticationChallenge.id,
        expiresAt: result.authenticationChallenge.expiresAt,
      },
    });
  } catch (error) {
    console.error("MFA enrollment error:", error);
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to enroll MFA factor" },
      { status },
    );
  }
}
