import { NextRequest, NextResponse } from "next/server";

import { ACQUISITION_SURVEY_FLAG_KEY } from "@/lib/analytics/acquisition-survey";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getPostHogFeatureFlagForUser } from "@/lib/posthog/server";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    const available = await getPostHogFeatureFlagForUser(
      ACQUISITION_SURVEY_FLAG_KEY,
      userId,
    );

    return NextResponse.json({ available }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { available: false },
      { headers: NO_STORE_HEADERS },
    );
  }
}
