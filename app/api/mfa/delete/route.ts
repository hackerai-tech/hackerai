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
      return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Failed to remove MFA factor" }, { status });
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

    const factorId = (body as any)?.factorId as string | undefined;
    const code = (body as any)?.code as string | undefined;

    if (!factorId || !code) {
      return NextResponse.json({ error: "factorId and code are required" }, { status: 400 });
    }

    if (code.length !== 6) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    // Ensure factor belongs to the authenticated user
    const factors = await workos.userManagement.listAuthFactors({ userId });
    const ownsFactor = factors.data.some((f) => f.id === factorId);
    if (!ownsFactor) {
      return NextResponse.json({ error: "Factor not found" }, { status: 404 });
    }

    // Create challenge and verify code
    const challenge = await workos.mfa.challengeFactor({
      authenticationFactorId: factorId,
    });

    const verification = await workos.mfa.verifyChallenge({
      authenticationChallengeId: challenge.id,
      code,
    });

    if (!verification.valid) {
      return NextResponse.json({ error: "Invalid verification code" }, { status: 400 });
    }

    // Delete factor
    await workos.mfa.deleteFactor(factorId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.toLowerCase().includes("expired")) {
        return NextResponse.json({ error: "Challenge has expired" }, { status: 400 });
      }
    }
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to remove MFA factor" },
      { status },
    );
  }
}


