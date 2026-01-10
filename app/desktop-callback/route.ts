import { NextResponse } from "next/server";
import { exchangeDesktopTransferToken } from "@/lib/desktop-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const sessionData = await exchangeDesktopTransferToken(token);

  if (!sessionData) {
    return NextResponse.redirect(new URL("/login", request.url));
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
