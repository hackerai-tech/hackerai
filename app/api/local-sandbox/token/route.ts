import { NextRequest, NextResponse } from "next/server";
import { fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getUserID } from "@/lib/auth/get-user-id";

/**
 * Generate or retrieve auth token for local sandbox
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getUserID(request);

    const result = await fetchMutation(api.localSandbox.getToken, { userId });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Get token error:", error);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Regenerate auth token
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserID(request);

    const result = await fetchMutation(api.localSandbox.regenerateToken, { userId });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Regenerate token error:", error);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
