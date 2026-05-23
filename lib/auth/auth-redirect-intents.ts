import { NextResponse } from "next/server";
import {
  ATTRIBUTION_COOKIE_NAME,
  buildInitialAttribution,
  encodeAttributionCookie,
} from "@/lib/analytics/attribution";

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
  options: { captureAttribution?: boolean; referrer?: string | null } = {},
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

  const hasTrackingParams =
    requestUrl.searchParams.has("utm_source") ||
    requestUrl.searchParams.has("utm_medium") ||
    requestUrl.searchParams.has("utm_campaign") ||
    requestUrl.searchParams.has("gclid") ||
    requestUrl.searchParams.has("fbclid") ||
    requestUrl.searchParams.has("msclkid");
  const shouldCaptureAttribution =
    options.captureAttribution || hasTrackingParams || !!options.referrer;
  const attributionCookie = shouldCaptureAttribution
    ? encodeAttributionCookie(
        buildInitialAttribution({
          href: requestUrl.toString(),
          referrer: options.referrer,
        }),
      )
    : null;
  if (attributionCookie) {
    response.cookies.set(ATTRIBUTION_COOKIE_NAME, attributionCookie, {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 90,
      path: "/",
    });
  }

  return response;
}
