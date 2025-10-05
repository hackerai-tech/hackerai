import { NextResponse } from "next/server";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

const ALLOWED_INTENTS: Record<string, string> = {
  pricing: "/#pricing",
};

export async function GET(request: Request) {
  const intent = new URL(request.url).searchParams.get("intent");
  const authorizationUrl = await getSignInUrl();
  const response = NextResponse.redirect(authorizationUrl);

  if (intent && ALLOWED_INTENTS[intent]) {
    response.cookies.set("post_login_redirect", ALLOWED_INTENTS[intent], {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

  return response;
}
