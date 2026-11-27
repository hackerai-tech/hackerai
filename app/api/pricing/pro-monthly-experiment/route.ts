import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { resolveProMonthlyQuote } from "@/lib/experiments/pro-monthly-pricing-hac248.server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * The account's authoritative monthly Pro quote. Only an explicit pricing
 * surface calls this, so it may enroll an eligible new account.
 */
export async function GET(req: NextRequest) {
  const { userId, subscription } = await getUserIDAndPro(req);

  try {
    const { price, assignment } = await resolveProMonthlyQuote({
      userId,
      subscription,
      enroll: true,
    });
    return NextResponse.json(
      { ...price, ...(assignment && { assignment }) },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { error: "Pro monthly price is unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
