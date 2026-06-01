import { NextResponse } from "next/server";

export const AUTH_REDIRECT_INTENTS: Record<string, string> = {
  pricing: "/#pricing",
  "migrate-pentestgpt": "/?confirm-migrate-pentestgpt=true",
};

export function getAuthRedirectPath(url: URL): string | null {
  const intent = url.searchParams.get("intent");
  const confirmMigrate = url.searchParams.get("confirm-migrate-pentestgpt");

  if (intent && AUTH_REDIRECT_INTENTS[intent]) {
    return AUTH_REDIRECT_INTENTS[intent];
  }

  if (confirmMigrate === "true") {
    return AUTH_REDIRECT_INTENTS["migrate-pentestgpt"];
  }

  return null;
}

export function redirectToAuthorizationUrl(
  authorizationUrl: string,
  requestUrl: URL,
): NextResponse {
  const response = NextResponse.redirect(authorizationUrl);
  const redirectPath = getAuthRedirectPath(requestUrl);

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
