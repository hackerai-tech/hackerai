import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirectToAuthorizationUrl } from "@/lib/auth/auth-redirect-intents";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const authorizationUrl = await getSignUpUrl();
  return redirectToAuthorizationUrl(authorizationUrl, url);
}
