import { NextRequest, NextResponse } from "next/server";
import { getExecutionRegionForVercelRequest } from "@/lib/api/trigger-region";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const region = getExecutionRegionForVercelRequest(request);

  return NextResponse.json(
    { region },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
