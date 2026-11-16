import { NextRequest, NextResponse } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { USER_SKILLS_FLAG } from "@/lib/user-skills/contracts";
export async function GET(req: NextRequest) {
  let enabled = false;
  try {
    const { userId } = await getUserIDAndPro(req);
    enabled =
      (await getPostHogBooleanFlagDecisionForUser(
        USER_SKILLS_FLAG,
        userId,
        undefined,
        { sendFeatureFlagEvents: false },
      )) === true;
  } catch {
    /* Unauthenticated or unavailable: fail closed. */
  }
  return NextResponse.json(
    { enabled },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
