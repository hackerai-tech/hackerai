import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/selfhost/session";
import { localOnly, sameOrigin } from "@/lib/selfhost/http";
export async function POST(request: Request) {
  const unavailable = localOnly();
  if (unavailable) return unavailable;
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
