import { NextResponse, type NextRequest } from "next/server";
import {
  readSession,
  SESSION_COOKIE,
  signSession,
} from "@/lib/selfhost/session";
import { localOnly } from "@/lib/selfhost/http";

export async function GET(request: NextRequest) {
  const unavailable = localOnly();
  if (unavailable) return unavailable;
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session)
    return NextResponse.json(
      { auth: { user: null } },
      { headers: { "Cache-Control": "no-store" } },
    );
  const { accessToken: _, ...auth } = session;
  const authTime = Date.parse(session.user.lastSignInAt) / 1000;
  return NextResponse.json(
    { auth, accessToken: await signSession(authTime, "5m", session.sessionId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
