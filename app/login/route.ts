import { NextResponse } from "next/server";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

const ALLOWED_INTENTS: Record<string, string> = {
  pricing: "/#pricing",
  "migrate-pentestgpt": "/?confirm-migrate-pentestgpt=true",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent");
  const confirmMigrate = url.searchParams.get("confirm-migrate-pentestgpt");
  
  const authorizationUrl = await getSignInUrl();
  const response = NextResponse.redirect(authorizationUrl);

  let redirectPath = null;

  if (intent && ALLOWED_INTENTS[intent]) {
    redirectPath = ALLOWED_INTENTS[intent];
  } else if (confirmMigrate === "true") {
    redirectPath = ALLOWED_INTENTS["migrate-pentestgpt"];
  }

  if (redirectPath) {
    response.cookies.set("post_login_redirect", redirectPath, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

  return response;
}
