import { NextRequest, NextResponse } from "next/server";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT } from "@/lib/experiments/agent-auto-review";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  try {
    await getUserIDAndPro(req);

    return NextResponse.json(
      {
        available: true,
        phase: DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT.phase,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.warn("Failed to resolve Agent Auto review availability", {
      event: "agent_auto_review_availability_route_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { available: false },
      { headers: NO_STORE_HEADERS },
    );
  }
}
