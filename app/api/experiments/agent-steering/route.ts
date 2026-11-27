import type { NextRequest } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    return Response.json(
      { enabled: Boolean(userId) },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return Response.json({ enabled: false }, { headers: NO_STORE_HEADERS });
  }
}
