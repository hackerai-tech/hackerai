import type { NextRequest } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { getPostHogFeatureFlagRawValueForUser } from "@/lib/posthog/server";

const CHAT_STARTERS_FLAG_KEY = "chat_starters_v1";
// Availability is per account; shared caches must never reuse it.
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return Response.json(
      { enabled: false },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  let enabled = false;
  try {
    // Only an explicit boolean true enables starters; variants, missing
    // configuration and lookup failures all fail closed.
    enabled =
      (await getPostHogFeatureFlagRawValueForUser(
        CHAT_STARTERS_FLAG_KEY,
        userId,
      )) === true;
  } catch {
    enabled = false;
  }

  return Response.json({ enabled }, { headers: NO_STORE_HEADERS });
}
