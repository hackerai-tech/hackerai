import { NextResponse } from "next/server";
import { exchangeDesktopTransferToken } from "@/lib/desktop-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    console.warn("[Desktop Callback] No token provided in callback URL");
    return NextResponse.redirect(new URL("/login?error=missing_token", request.url));
  }

  const sessionData = await exchangeDesktopTransferToken(token);

  if (!sessionData) {
    console.warn("[Desktop Callback] Token exchange failed");
    return NextResponse.redirect(new URL("/login?error=token_expired", request.url));
  }

  const response = NextResponse.redirect(new URL("/", request.url));

  response.cookies.set("wos-session", sessionData.sealedSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  return response;
}
