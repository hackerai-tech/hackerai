import { NextRequest, NextResponse } from "next/server";
import { workos } from "@/app/api/workos";
import { getUserID } from "@/lib/auth/get-user-id";

export async function POST(req: NextRequest) {
  try {
    // Get the current user ID
    const userId = await getUserID(req);

    // List all sessions for the user
    const sessionsResponse = await workos.userManagement.listSessions(userId);

    // Revoke all sessions (tolerate already-ended sessions)
    const revokePromises = sessionsResponse.data.map((session) =>
      workos.userManagement.revokeSession({ sessionId: session.id }),
    );

    await Promise.allSettled(revokePromises);

    return NextResponse.json({
      success: true,
      message: "All sessions revoked successfully",
      revokedSessions: sessionsResponse.data.length,
    });
  } catch (error) {
    console.error("Failed to revoke all sessions:", error);
    return NextResponse.json(
      { error: "Failed to revoke all sessions" },
      { status: 500 },
    );
  }
}
