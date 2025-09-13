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
      return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Failed to get MFA factors" }, { status });
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

export async function DELETE(req: NextRequest) {
  try {
    // Get authenticated user
    let userId: string;
    try {
      userId = await getUserID(req);
    } catch (e) {
      const status = isUnauthorizedError(e) ? 401 : 500;
      return NextResponse.json({ error: status === 401 ? "Unauthorized" : "Failed to delete MFA factor" }, { status });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const factorId = (body as any)?.factorId as string | undefined;

    if (!factorId) {
      return NextResponse.json({ error: "Factor ID is required" }, { status: 400 });
    }

    // Ensure factor belongs to the authenticated user
    const factors = await workos.userManagement.listAuthFactors({ userId });
    const ownsFactor = factors.data.some((f) => f.id === factorId);
    if (!ownsFactor) {
      return NextResponse.json({ error: "Factor not found" }, { status: 404 });
    }

    // Delete factor from WorkOS
    await workos.mfa.deleteFactor(factorId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete MFA factor error:", error);
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to delete MFA factor" },
      { status },
    );
  }
}
