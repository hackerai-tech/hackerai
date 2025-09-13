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
      return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Failed to verify MFA challenge" }, { status });
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const challengeId = (body as any)?.challengeId as string | undefined;
    const code = (body as any)?.code as string | undefined;

    if (!challengeId || !code) {
      return NextResponse.json(
        { error: "Challenge ID and verification code are required" },
        { status: 400 },
      );
    }

    // Verify challenge with WorkOS
    const verification = await workos.mfa.verifyChallenge({
      authenticationChallengeId: challengeId,
      code: code,
    });

    return NextResponse.json({
      valid: verification.valid,
      challenge: verification.challenge,
    });
  } catch (error) {
    console.error("MFA verification error:", error);

    // Handle specific WorkOS errors
    if (error instanceof Error) {
      if (error.message.includes("already verified")) {
        return NextResponse.json(
          { error: "Challenge has already been verified" },
          { status: 400 },
        );
      }
      if (error.message.includes("expired")) {
        return NextResponse.json(
          { error: "Challenge has expired" },
          { status: 400 },
        );
      }
    }

    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to verify MFA challenge" },
      { status },
    );
  }
}
