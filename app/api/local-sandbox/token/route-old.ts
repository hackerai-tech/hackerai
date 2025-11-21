import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getUserID } from "@/lib/auth/get-user-id";

// In production, store this in database (Convex user_settings table)
// For now, using in-memory Map
const userTokens = new Map<string, string>();

/**
 * Generate or retrieve auth token for local sandbox
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserID(request);

    // Check if user already has a token
    let token = userTokens.get(userId);

    if (!token) {
      // Generate new token
      token = `hsb_${randomBytes(32).toString("hex")}`;
      userTokens.set(userId, token);
    }

    return NextResponse.json({ token });
  } catch (error) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Regenerate auth token
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserID(request);

    // Generate new token
    const token = `hsb_${randomBytes(32).toString("hex")}`;
    userTokens.set(userId, token);

    return NextResponse.json({ token, regenerated: true });
  } catch (error) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Verify token (internal use)
 */
export function verifyToken(token: string): string | null {
  for (const [userId, userToken] of userTokens.entries()) {
    if (userToken === token) {
      return userId;
    }
  }
  return null;
}
