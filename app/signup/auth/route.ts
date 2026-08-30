import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { redirectToAuthorizationUrl } from "@/lib/auth/auth-redirect-intents";
import { FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME } from "@/lib/analytics/acquisition";
import { parseFirstTouchAttributionCookie } from "@/lib/analytics/acquisition-cookie";
import { createSignupAttributionState } from "@/lib/analytics/signup-acquisition-state";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieStore = await cookies();
  const firstTouch = parseFirstTouchAttributionCookie(
    cookieStore.get(FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME)?.value,
  );
  const authorizationUrl = await getSignUpUrl(
    firstTouch
      ? { state: createSignupAttributionState(firstTouch) }
      : undefined,
  );
  return redirectToAuthorizationUrl(authorizationUrl, url);
}
